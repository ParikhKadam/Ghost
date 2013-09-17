// Module dependencies
var express = require('express'),
    when = require('when'),
    _ = require('underscore'),
    colors = require("colors"),
    semver = require("semver"),
    slashes = require("connect-slashes"),
    errors = require('./server/errorHandling'),
    admin = require('./server/controllers/admin'),
    frontend = require('./server/controllers/frontend'),
    api = require('./server/api'),
    path = require('path'),
    hbs = require('express-hbs'),
    Ghost = require('./ghost'),
    helpers = require('./server/helpers'),
    packageInfo = require('../package.json'),

// Variables
    loading = when.defer(),
    server = express(),
    ghost = new Ghost();

// ##Custom Middleware

// ### Auth Middleware
// Authenticate a request by redirecting to login if not logged in.
// We strip /ghost/ out of the redirect parameter for neatness
function auth(req, res, next) {
    if (!req.session.user) {
        var path = req.path.replace(/^\/ghost\/?/gi, ''),
            redirect = '',
            msg;

        if (path !== '') {
            msg = {
                type: 'error',
                message: 'Please Sign In',
                status: 'passive',
                id: 'failedauth'
            };
            // let's only add the notification once
            if (!_.contains(_.pluck(ghost.notifications, 'id'), 'failedauth')) {
                ghost.notifications.push(msg);
            }
            redirect = '?r=' + encodeURIComponent(path);
        }
        return res.redirect('/ghost/signin/' + redirect);
    }

    next();
}


// Check if we're logged in, and if so, redirect people back to dashboard
// Login and signup forms in particular
function redirectToDashboard(req, res, next) {
    if (req.session.user) {
        return res.redirect('/ghost/');
    }

    next();
}

function redirectToSignup(req, res, next) {
    api.users.browse().then(function (users) {
        if (users.length === 0) {
            return res.redirect('/ghost/signup/');
        }
    });

    next();
}

// While we're here, let's clean up on aisle 5
// That being ghost.notifications, and let's remove the passives from there
// plus the local messages, as they have already been added at this point
// otherwise they'd appear one too many times
function cleanNotifications(req, res, next) {
    ghost.notifications = _.reject(ghost.notifications, function (notification) {
        return notification.status === 'passive';
    });
    next();
}

// ## AuthApi Middleware
// Authenticate a request to the API by responding with a 401 and json error details
function authAPI(req, res, next) {
    if (!req.session.user) {
        // TODO: standardize error format/codes/messages
        res.json(401, { error: 'Please sign in' });
        return;
    }

    next();
}

// ### GhostLocals Middleware
// Expose the standard locals that every external page should have available,
// separating between the theme and the admin
function ghostLocals(req, res, next) {
    // Make sure we have a locals value.
    res.locals = res.locals || {};
    res.locals.version = packageInfo.version;
    res.locals.path = req.path;

    if (res.isAdmin) {
        _.extend(res.locals,  {
            messages: ghost.notifications
        });

        api.users.read({id: req.session.user}).then(function (currentUser) {
            _.extend(res.locals,  {
                currentUser: {
                    name: currentUser.attributes.name,
                    profile: currentUser.attributes.image
                }
            });
            next();
        }).otherwise(function () {
            next();
        });
    } else {
        next();
    }
}

// ### DisableCachedResult Middleware
// Disable any caching until it can be done properly
function disableCachedResult(req, res, next) {
    res.set({
        "Cache-Control": "no-cache, must-revalidate",
        "Expires": "Sat, 26 Jul 1997 05:00:00 GMT"
    });

    next();
}

// ### whenEnabled Middleware
// Selectively use middleware
// From https://github.com/senchalabs/connect/issues/676#issuecomment-9569658
function whenEnabled(setting, fn) {
    return function settingEnabled(req, res, next) {
        if (server.enabled(setting)) {
            fn(req, res, next);
        } else {
            next();
        }
    };
}

// ### InitViews Middleware
// Initialise Theme or Admin Views
function initViews(req, res, next) {
    var hbsOptions;

    if (!res.isAdmin) {
        // self.globals is a hack til we have a better way of getting combined settings & config
        hbsOptions = {templateOptions: {data: {blog: ghost.blogGlobals()}}};

        if (ghost.themeDirectories[ghost.settings('activeTheme')].hasOwnProperty('partials')) {
            // Check that the theme has a partials directory before trying to use it
            hbsOptions.partialsDir = path.join(ghost.paths().activeTheme, 'partials');
        }

        server.engine('hbs', hbs.express3(hbsOptions));
        server.set('views', ghost.paths().activeTheme);
    } else {
        server.engine('hbs', hbs.express3({partialsDir: ghost.paths().adminViews + 'partials'}));
        server.set('views', ghost.paths().adminViews);
    }

    next();
}

// ### Activate Theme
// Helper for manageAdminAndTheme
function activateTheme() {
    var stackLocation = _.indexOf(server.stack, _.find(server.stack, function (stackItem, key) {
        return stackItem.route === '' && stackItem.handle.name === 'settingEnabled';
    }));

    // clear the view cache
    server.cache = {};
    server.disable(server.get('activeTheme'));
    server.set('activeTheme', ghost.settings('activeTheme'));
    server.enable(server.get('activeTheme'));
    if (stackLocation) {
        server.stack[stackLocation].handle = whenEnabled(server.get('activeTheme'), express['static'](ghost.paths().activeTheme));
    }
}

 // ### ManageAdminAndTheme Middleware
// Uses the URL to detect whether this response should be an admin response
// This is used to ensure the right content is served, and is not for security purposes
function manageAdminAndTheme(req, res, next) {
    // TODO improve this regex
    res.isAdmin = /(^\/ghost\/)/.test(req.url);
    if (res.isAdmin) {
        server.enable('admin');
        server.disable(server.get('activeTheme'));
    } else {
        server.enable(server.get('activeTheme'));
        server.disable('admin');
    }

    // Check if the theme changed
    if (ghost.settings('activeTheme') !== server.get('activeTheme')) {
        // Change theme
        if (!ghost.themeDirectories.hasOwnProperty(ghost.settings('activeTheme'))) {
            if (!res.isAdmin) {
                // Throw an error if the theme is not available, but not on the admin UI
                errors.logAndThrowError('The currently active theme ' + ghost.settings('activeTheme') + ' is missing.');
            }
        } else {
            activateTheme();
        }
    }

    next();
}

// Expose the promise we will resolve after our pre-loading
ghost.loaded = loading.promise;

when.all([ghost.init(), helpers.loadCoreHelpers(ghost)]).then(function () {

    // ##Configuration
    var oneYear = 31536000000;

    // Logging configuration
    if (server.get('env') !== "development") {
        server.use(express.logger());
    } else {
        server.use(express.logger('dev'));
    }

    // return the correct mime type for woff filess
    express['static'].mime.define({'application/font-woff': ['woff']});
    // Shared static config
    server.use('/shared', express['static'](path.join(__dirname, '/shared')));
    server.use('/content/images', express['static'](path.join(__dirname, '/../content/images')));
    // Serve our built scripts; can't use /scripts here because themes already are
    server.use("/built/scripts", express['static'](path.join(__dirname, '/built/scripts'), {
        // Put a maxAge of one year on built scripts
        maxAge: oneYear
    }));

    // First determine whether we're serving admin or theme content
    server.use(manageAdminAndTheme);

    // Admin only config
    server.use('/ghost', whenEnabled('admin', express['static'](path.join(__dirname, '/client/assets'))));

    // Theme only config
    server.use(whenEnabled(server.get('activeTheme'), express['static'](ghost.paths().activeTheme)));

    // Add in all trailing slashes
    server.use(slashes());

    server.use(express.favicon(__dirname + '/shared/favicon.ico'));
    server.use(express.bodyParser({}));
    server.use(express.bodyParser({uploadDir: __dirname + '/content/images'}));
    server.use(express.cookieParser(ghost.dbHash));
    server.use(express.cookieSession({ cookie: { maxAge: 60000000 }}));

    // local data
    server.use(ghostLocals);
    // So on every request we actually clean out reduntant passive notifications from the server side
    server.use(cleanNotifications);

     // set the view engine
    server.set('view engine', 'hbs');

     // Initialise the views
    server.use(initViews);

    // process the application routes
    server.use(server.router);

    // ### Error handling
    // 404 Handler
    server.use(errors.render404Page);

    // TODO: Handle all application errors (~500)
    // Just stubbed at this stage!
    server.use(function error500Handler(err, req, res, next) {
        if (!err || !(err instanceof Error)) {
            next();
        }

        // For the time being, just log and continue.
        errors.logError(err, "Middleware", "Ghost caught a processing error in the middleware layer.");
        next(err);
    });

    // All other errors
    if (server.get('env') === "production") {
        server.use(express.errorHandler({ dumpExceptions: false, showStack: false }));
    } else {
        server.use(express.errorHandler({ dumpExceptions: true, showStack: true }));
    }

    // ## Routing

    // ### API routes
    /* TODO: auth should be public auth not user auth */
    // #### Posts
    server.get('/api/v0.1/posts', authAPI, disableCachedResult, api.requestHandler(api.posts.browse));
    server.post('/api/v0.1/posts', authAPI, disableCachedResult, api.requestHandler(api.posts.add));
    server.get('/api/v0.1/posts/:id', authAPI, disableCachedResult, api.requestHandler(api.posts.read));
    server.put('/api/v0.1/posts/:id', authAPI, disableCachedResult, api.requestHandler(api.posts.edit));
    server.del('/api/v0.1/posts/:id', authAPI, disableCachedResult, api.requestHandler(api.posts.destroy));
    // #### Settings
    server.get('/api/v0.1/settings/', authAPI, disableCachedResult, api.requestHandler(api.settings.browse));
    server.get('/api/v0.1/settings/:key/', authAPI, disableCachedResult, api.requestHandler(api.settings.read));
    server.put('/api/v0.1/settings/', authAPI, disableCachedResult, api.requestHandler(api.settings.edit));
    // #### Users
    server.get('/api/v0.1/users/', authAPI, disableCachedResult, api.requestHandler(api.users.browse));
    server.get('/api/v0.1/users/:id/', authAPI, disableCachedResult, api.requestHandler(api.users.read));
    server.put('/api/v0.1/users/:id/', authAPI, disableCachedResult, api.requestHandler(api.users.edit));
    // #### Tags
    server.get('/api/v0.1/tags/', authAPI, disableCachedResult, api.requestHandler(api.tags.all));
    // #### Notifications
    server.del('/api/v0.1/notifications/:id', authAPI, disableCachedResult, api.requestHandler(api.notifications.destroy));
    server.post('/api/v0.1/notifications/', authAPI, disableCachedResult, api.requestHandler(api.notifications.add));


    // ### Admin routes
    /* TODO: put these somewhere in admin */
    server.get(/^\/logout\/?$/, function redirect(req, res) {
        res.redirect(301, '/signout/');
    });
    server.get(/^\/signout\/?$/, admin.logout);
    server.get('/ghost/login/', function redirect(req, res) {
        res.redirect(301, '/ghost/signin/');
    });
    server.get('/ghost/signin/', redirectToSignup, redirectToDashboard, admin.login);
    server.get('/ghost/signup/', redirectToDashboard, admin.signup);
    server.get('/ghost/forgotten/', redirectToDashboard, admin.forgotten);
    server.post('/ghost/forgotten/', admin.resetPassword);
    server.post('/ghost/signin/', admin.auth);
    server.post('/ghost/signup/', admin.doRegister);
    server.post('/ghost/changepw/', auth, admin.changepw);
    server.get('/ghost/editor(/:id)/', auth, admin.editor);
    server.get('/ghost/editor/', auth, admin.editor);
    server.get('/ghost/content/', auth, admin.content);
    server.get('/ghost/settings*', auth, admin.settings);
    server.get('/ghost/debug/', auth, admin.debug.index);
    server.get('/ghost/debug/db/export/', auth, admin.debug['export']);
    server.post('/ghost/debug/db/import/', auth, admin.debug['import']);
    server.get('/ghost/debug/db/reset/', auth, admin.debug.reset);
    server.post('/ghost/upload/', admin.uploader);
    server.get(/^\/(ghost$|(ghost-admin|admin|wp-admin|dashboard|signin)\/?)/, auth, function (req, res) {
        res.redirect('/ghost/');
    });
    server.get('/ghost/', redirectToSignup, auth, admin.index);

    // ### Frontend routes
    /* TODO: dynamic routing, homepage generator, filters ETC ETC */
    server.get('/rss/', frontend.rss);
    server.get('/rss/:page/', frontend.rss);
    server.get('/page/:page/', frontend.homepage);
    server.get('/:slug/', frontend.single);
    server.get('/', frontend.homepage);



    // ## Start Ghost App
    server.listen(
        ghost.config().server.port,
        ghost.config().server.host,
        function () {

            // Tell users if their node version is not supported, and exit
            if (!semver.satisfies(process.versions.node, packageInfo.engines.node)) {
                console.log(
                    "\nERROR: Unsupported version of Node".red,
                    "\nGhost needs Node version".red,
                    packageInfo.engines.node.yellow,
                    "you are using version".red,
                    process.versions.node.yellow,
                    "\nPlease go to http://nodejs.org to get the latest version".green
                );

                process.exit(0);
            }

            // Startup & Shutdown messages
            if (process.env.NODE_ENV === 'production') {
                console.log(
                    "Ghost is running...".green,
                    "\nYour blog is now available on",
                    ghost.config().url,
                    "\nCtrl+C to shut down".grey
                );

                // ensure that Ghost exits correctly on Ctrl+C
                process.on('SIGINT', function () {
                    console.log(
                        "\nGhost has shut down".red,
                        "\nYour blog is now offline"
                    );
                    process.exit(0);
                });
            } else {
                console.log(
                    "Ghost is running...".green,
                    "\nListening on",
                    ghost.config().server.host + ':' + ghost.config().server.port,
                    "\nUrl configured as:",
                    ghost.config().url,
                    "\nCtrl+C to shut down".grey
                );
                // ensure that Ghost exits correctly on Ctrl+C
                process.on('SIGINT', function () {
                    console.log(
                        "\nGhost has shutdown".red,
                        "\nGhost was running for",
                        Math.round(process.uptime()),
                        "seconds"
                    );
                    process.exit(0);
                });
            }

            // Let everyone know we have finished loading
            loading.resolve();
        }
    );
}, errors.logAndThrowError);
