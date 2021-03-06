// Necessary packages
const fs = require('fs-extra');
const path = require('path');
const moment = require('moment');
const Handlebars = require('handlebars');
const CleanCSS = require('clean-css');
const normalizePath = require('normalize-path');

// Internal packages
const slug = require('./../../helpers/slug');
const sql = require('../../vendor/sql.js');
const URLHelper = require('./helpers/url.js');
const FilesHelper = require('./helpers/files.js');
const PostViewSettingsHelper = require('./helpers/post-view-settings.js');
const Themes = require('../../themes.js');
const TemplateHelper = require('./helpers/template.js');
const RendererContext = require('./renderer-context.js');
const RendererContextPost = require('./contexts/post.js');
const RendererContextPostPreview = require('./contexts/post-preview.js');
const RendererContextTag = require('./contexts/tag.js');
const RendererContextAuthor = require('./contexts/author.js');
const RendererContextHome = require('./contexts/home.js');
const RendererContextFeed = require('./contexts/feed.js');
const RendererContext404 = require('./contexts/404.js');
const RendererContextSearch = require('./contexts/search.js');
const themeConfigValidator = require('./validators/theme-config.js');
const UtilsHelper = require('./../../helpers/utils');
const Sitemap = require('./helpers/sitemap.js');
const Gdpr = require('./helpers/gdpr.js');

// Default config
const defaultAstCurrentSiteConfig = require('./../../../config/AST.currentSite.config');

/*
 * Class used to generate HTML output
 * from the site data
 */

class Renderer {
    constructor(appDir, sitesDir, siteConfig, postID = false, postData = false) {
        this.appDir = appDir;
        this.sitesDir = sitesDir;
        this.siteConfig = siteConfig;
        this.siteName = this.siteConfig.name;
        this.themeName = this.siteConfig.theme;
        this.menuContext = '';
        this.errorLog = [];
        this.previewMode = false;
        this.ampMode = false;
        this.translations = {
            user: false,
            theme: false
        };
        this.contentStructure = {};
        this.commonData = {
            tags: [],
            authors: [],
            menus: [],
            featuredPosts: {
                homepage: [],
                tag: [],
                author: []
            },
            hiddenPosts: []
        };
        this.cachedItems = {
            postTags: {},
            posts: {},
            tags: {},
            tagsPostCounts: {},
            authors: {},
            authorsPostCounts: {},
            featuredImages: {}
        };

        if(postID !== false) {
            this.postID = postID;
            this.postData = postData;
        }
    }

    /*
     * Renders the pages
     */
    async render(previewMode = false, previewLocation = '', singlePageMode = false) {
        this.previewMode = previewMode;
        this.previewLocation = previewLocation;
        this.singlePageMode = singlePageMode;
        this.setIO();
        this.emptyOutputDir();
        let themeValidationResults = this.themeIsValid();

        if(themeValidationResults === true) {
            await this.renderSite();

            if(this.errorLog.length === 0) {
                return true;
            }

            return this.errorLog;
        } else {
            this.errorLog.push({
                message: 'An error (1010) occurred during parsing config.json file of the theme.',
                desc: 'Please check your theme config.json file as it seems to be corrupted.'
            });

            return this.errorLog;
        }

        // Return validation error message
        return themeValidationResults;
    }

    /*
     * Check if the theme is valid
     */
    themeIsValid() {
        let configFilePath = path.join(this.inputDir, 'themes', this.themeName, 'config.json');
        let overridedConfigFilePath = UtilsHelper.fileIsOverrided(this.inputDir, this.themeName, configFilePath);

        if(overridedConfigFilePath) {
            configFilePath = overridedConfigFilePath;
        }

        let configValidationResult = themeConfigValidator(configFilePath);

        if(configValidationResult !== true) {
            return 'Theme config.json file is invalid: ' + configValidationResult;
        }

        return true;
    }

    /*
     * Render the page content after removing the old output dir
     */
    async renderSite() {
        if (this.singlePageMode) {
            this.renderPostPreview();
        } else {
            await this.renderFullPreview();
        }

        return true;
    }

    /**
     * Renders full preview of website
     */
    async renderFullPreview() {
        console.time("RENDERING");
        this.preparePageToRender();
        await this.generateWWW();
        this.generateAMP();
        console.timeEnd("RENDERING");
        this.sendProgress(100, 'Website files are ready to upload');
    }

    /**
     * Prepares website to be rendered
     */
    preparePageToRender() {
        this.loadSiteConfig();

        this.sendProgress(1, 'Loading website config');

        console.time("CONFIG");
        this.loadSiteTranslations();
        this.loadDataFromDB();
        this.loadThemeConfig();
        this.loadThemeFiles();
        this.registerHelpers();
        this.registerThemeHelpers();
        console.timeEnd("CONFIG");

        this.sendProgress(2, 'Loading website assets');
        this.loadContentStructure();
        this.sendProgress(5, 'Loading content structure');

        this.loadCommonData();
        this.sendProgress(10, 'Preloading common data');
        this.generatePartials();
    }

    /**
     * Creates website content
     */
    async generateWWW() {
        this.sendProgress(11, 'Generating frontpage');
        this.generateFrontpage();
        this.sendProgress(20, 'Generating posts');
        this.generatePosts();
        this.sendProgress(60, 'Generating tag pages');
        this.generateTags();
        this.sendProgress(70, 'Generating author pages');
        this.generateAuthors();
        this.sendProgress(75, 'Generating other pages');
        this.generate404s();
        this.generateSearch();
        this.generateFeeds();
        this.generateCSS();
        this.sendProgress(80, 'Copying files');
        this.copyFiles();
        await this.generateSitemap();
        this.sendProgress(90, 'Finishing the render process');
    }

    /**
     * Renders post preview
     */
    renderPostPreview() {
        this.loadSiteConfig();
        this.loadSiteTranslations();
        this.loadDataFromDB();
        this.loadThemeConfig();
        this.loadThemeFiles();
        this.registerHelpers();
        this.registerThemeHelpers();
        this.loadContentStructure();
        this.loadCommonData();
        this.generatePartials();
        this.generatePost();
        this.generateCSS();
        FilesHelper.copyAssetsFiles(this.themeDir, this.outputDir, this.themeConfig);
        FilesHelper.copyMediaFiles(this.inputDir, this.outputDir);

        process.send({
            type: 'app-rendering-preview',
            result: true
        });
    }

    /**
     * Send progress to the renderer thread
     *
     * @param progress
     * @param message
     */
    sendProgress(progress, message = '') {
        process.send({
            type: 'app-rendering-progress',
            progress: progress,
            message: message
        });
    }

    /*
     * Make sure the output dir exists and is empty before generating the output files
     */
    emptyOutputDir() {
        if(UtilsHelper.dirExists(this.outputDir)) {
            fs.emptyDirSync(this.outputDir);
        } else {
            fs.mkdirSync(this.outputDir);
        }
    }

    /*
     * Set the directories used as an input and an output
     */
    setIO() {
        let basePath = path.join(this.sitesDir, this.siteName);
        this.inputDir = path.join(basePath, 'input');
        this.themeDir = path.join(this.inputDir, 'themes', this.themeName);
        this.outputDir = path.join(basePath, 'output');

        if(this.previewMode) {
            this.outputDir = path.join(basePath, 'preview');

            if(this.previewLocation !== '' && UtilsHelper.dirExists(this.previewLocation)) {
                this.outputDir = this.previewLocation;
            }
        }
    }

    /*
     * Create built-in helpers
     */
    registerHelpers() {
        const HandlebarsHelpers = require('./handlebars/helpers/_modules.js');

        // Get helpers names
        let helperNames = Object.keys(HandlebarsHelpers);

        // Register all helpers
        for(let helperName of helperNames) {
            if(helperName.substr(-6) !== 'Helper') {
                Handlebars.registerHelper(
                    helperName,
                    HandlebarsHelpers[helperName]
                );
            } else {
                HandlebarsHelpers[helperName](this, Handlebars);
            }
        }
    }

    /*
     * Create theme custom helpers
     */
    registerThemeHelpers() {
        let helpersFilePath = path.join(this.themeDir, 'helpers.js');
        let overridedHelpersFilePath = UtilsHelper.fileIsOverrided(this.themeDir, helpersFilePath);

        if(overridedHelpersFilePath) {
            helpersFilePath = overridedHelpersFilePath;
        }

        // Check if the helpers.js file exists
        if(!UtilsHelper.fileExists(helpersFilePath)) {
            return;
        }

        // Include the helpers from the helpers.js file
        let themeHelpers;
        
        if (this.themeConfig.renderer.includeHandlebarsInHelpers) {
            themeHelpers = this.requireWithNoCache(helpersFilePath, Handlebars);
        } else {
            themeHelpers = this.requireWithNoCache(helpersFilePath);
        }

        // Check if the returned value is an object
        if(themeHelpers.constructor !== Object) {
            return;
        }

        // Get helpers names
        let helperNames = Object.keys(themeHelpers);

        // Register all helpers
        for(let helperName of helperNames) {
            Handlebars.registerHelper(helperName, themeHelpers[helperName]);
        }
    }

    /*
     * Load site config
     */
    loadSiteConfig() {
        let defaultSiteConfig = JSON.parse(JSON.stringify(defaultAstCurrentSiteConfig));
        // Site config
        let configPath = path.join(this.inputDir, 'config', 'site.config.json');
        this.siteConfig = JSON.parse(fs.readFileSync(configPath));
        this.siteConfig = UtilsHelper.mergeObjects(defaultSiteConfig, this.siteConfig);

        if(this.previewMode) {
            this.siteConfig.domain = 'file://' + this.outputDir;
        }

        if(
            this.siteConfig.advanced &&
            this.siteConfig.advanced.openGraphImage !== '' &&
            this.siteConfig.advanced.openGraphImage.indexOf('http://') === -1 &&
            this.siteConfig.advanced.openGraphImage.indexOf('https://') === -1 &&
            this.siteConfig.advanced.openGraphImage.indexOf('media/website/') === -1
        ) {
            let openGraphImage = path.join(this.siteConfig.domain, 'media', 'website', this.siteConfig.advanced.openGraphImage);
            openGraphImage = normalizePath(openGraphImage);
            openGraphImage = URLHelper.fixProtocols(openGraphImage);
            this.siteConfig.advanced.openGraphImage = openGraphImage;
        } else {
            this.siteConfig.advanced.openGraphImage = URLHelper.fixProtocols(this.siteConfig.advanced.openGraphImage);
        }
    }

    /*
     * Load site translations
     */
    loadSiteTranslations() {
        // Path to the custom translations
        let userTranslationsPath = path.join(
            this.inputDir,
            'languages',
            this.themeName + '.lang.json'
        );

        // Path to the original translations
        let themeTranslationsPath = path.join(
            this.inputDir,
            'themes',
            this.themeName,
            this.themeName + '.lang.json'
        );

        // Load custom translations
        if(fs.existsSync(userTranslationsPath)) {
            this.translations.user = this.parseTranslations(userTranslationsPath);
        }

        // Load original translations
        if(fs.existsSync(themeTranslationsPath)) {
            this.translations.theme = this.parseTranslations(themeTranslationsPath);
        }
    }

    /*
     * Parse site translations
     */
    parseTranslations(path) {
        let translations = false;

        try {
            translations = JSON.parse(fs.readFileSync(path));
        } catch(e) {
            return false;
        }

        return translations;
    }

    /*
     * Load all data from the database
     */
    loadDataFromDB() {
        const dbPath = path.join(this.inputDir, 'db.sqlite');
        const input = fs.readFileSync(dbPath);
        this.db = new sql.Database(input);
    }

    /*
     * Load and parse theme config file
     */
    loadThemeConfig() {
        let themeConfigPath = path.join(this.inputDir, 'config', 'theme.config.json');
        let tempThemeConfig = Themes.loadThemeConfig(themeConfigPath, this.themeDir);
        this.themeConfig = JSON.parse(JSON.stringify(tempThemeConfig));
        this.themeConfig.config = {};
        this.themeConfig.customConfig = {};
        this.themeConfig.postConfig = {};

        for(let i = 0; i < tempThemeConfig.config.length; i++) {
            let key = tempThemeConfig.config[i].name;
            this.themeConfig.config[key] = tempThemeConfig.config[i].value;
        }

        for(let i = 0; i < tempThemeConfig.customConfig.length; i++) {
            let key = tempThemeConfig.customConfig[i].name;
            this.themeConfig.customConfig[key] = tempThemeConfig.customConfig[i].value;
        }

        for(let i = 0; i < tempThemeConfig.postConfig.length; i++) {
            let key = tempThemeConfig.postConfig[i].name;
            this.themeConfig.postConfig[key] = tempThemeConfig.postConfig[i].value;
        }
    }

    /*
     * Load necessary theme files
     */
    loadThemeFiles() {
        this.templateHelper = new TemplateHelper(this.themeDir, this.outputDir, this.siteConfig);
    }

    /*
     * Generate partials
     */
    generatePartials() {
        let requiredPartials = ['header', 'footer'];
        let optionalPartials = [
            'pagination',
            'menu',
            'amp-footer',
            'amp-head',
            'amp-menu',
            'amp-pagination',
            'amp-share-buttons'
        ];
        let userPartials = this.templateHelper.getUserPartials(requiredPartials, optionalPartials);
        let allPartials = requiredPartials.concat(optionalPartials).concat(userPartials);

        for(let i = 0; i < allPartials.length; i++) {
            let template = this.templateHelper.loadPartialTemplate(allPartials[i] + '.hbs');

            if (!template && optionalPartials.indexOf(allPartials[i]) > -1) {
                let optionalPartialPath = path.join(__dirname, '..', '..', '..', 'default-files', 'theme-files', allPartials[i] + '.hbs');
                template = fs.readFileSync(optionalPartialPath, 'utf8');
            }

            if(!template) {
                continue;
            }

            try {
                Handlebars.registerPartial(allPartials[i], template);
            } catch (e) {
                this.errorLog.push({
                    message: 'An error (1001) occurred during parsing ' + allPartials[i] + '.hbs partial file.',
                    desc: e.message
                });
            }
        }
    }

    /*
     * Generate the main view of the theme
     */
    generateFrontpage(ampMode = false) {
        console.time(ampMode ? 'HOME-AMP' : 'HOME');
        // Load template
        let inputFile = ampMode ? 'amp-index.hbs' : 'index.hbs';
        let compiledTemplate = this.compileTemplate(inputFile);

        if (!compiledTemplate) {
            return false;
        }

        // Create global context
        let globalContext = this.createGlobalContext('index');

        // Render index site
        let contextGenerator = new RendererContextHome(this);

        // Detect if we have enough posts to create pagination
        let totalNumberOfPosts = contextGenerator.getPostsNumber();
        let postsPerPage = parseInt(this.themeConfig.config.postsPerPage, 10);

        if (isNaN(postsPerPage)) {
            postsPerPage = 5;
        }

        if (totalNumberOfPosts <= postsPerPage || postsPerPage <= 0) {
            let context = contextGenerator.getContext(0, postsPerPage);
            let output = '';

            this.menuContext = ['frontpage'];
            globalContext.website.pageUrl = this.siteConfig.domain + '/';
            globalContext.website.ampUrl = this.siteConfig.domain + '/amp/';
            globalContext.renderer.isFirstPage = true;
            globalContext.renderer.isLastPage = true;
            globalContext.pagination = false;

            if (!this.siteConfig.advanced.ampIsEnabled) {
                globalContext.website.ampUrl = '';
            }

            try {
                output = compiledTemplate(context, {
                    data: globalContext
                });
            } catch (e) {
                this.errorLog.push({
                    message: 'An error (1002) occurred during parsing ' + inputFile + ' file.',
                    desc: e.message
                });
                return;
            }

            this.templateHelper.saveOutputFile('index.html', output);
        } else {
            let addIndexHtml = this.previewMode || this.siteConfig.advanced.urls.addIndex;

            // If user set postsPerPage field to -1 - set it for calculations to 999
            postsPerPage = postsPerPage == -1 ? 999 : postsPerPage;

            for (let offset = 0; offset < totalNumberOfPosts; offset += postsPerPage) {
                globalContext.context = ['index'];
                let context = contextGenerator.getContext(offset, postsPerPage);

                // Add pagination data to the global context
                let currentPage = 1;
                let totalPages = 0;

                if (postsPerPage > 0) {
                    currentPage = parseInt(offset / postsPerPage, 10) + 1;
                    totalPages = Math.ceil(totalNumberOfPosts / postsPerPage)
                }

                let nextPage = (currentPage < totalPages) ? currentPage + 1 : false;
                let previousPage = (currentPage > 1) ? currentPage - 1 : false;

                globalContext.pagination = {
                    context: '',
                    pages: Array.from({length: totalPages}, (v, k) => k + 1),
                    totalPosts: totalNumberOfPosts,
                    totalPages: totalPages,
                    currentPage: currentPage,
                    postsPerPage: postsPerPage,
                    nextPage: nextPage,
                    previousPage: previousPage,
                    nextPageUrl: URLHelper.createPaginationPermalink(this.siteConfig.domain, this.siteConfig.advanced.urls, nextPage, 'home', false, addIndexHtml),
                    previousPageUrl: URLHelper.createPaginationPermalink(this.siteConfig.domain, this.siteConfig.advanced.urls, previousPage, 'home', false, addIndexHtml)
                };

                globalContext.renderer.isFirstPage = currentPage === 1;
                globalContext.renderer.isLastPage = currentPage === totalPages;

                if (currentPage > 1) {
                    let pagePart = this.siteConfig.advanced.urls.pageName;
                    globalContext.website.pageUrl = this.siteConfig.domain + '/' + pagePart +  '/' + currentPage + '/';
                    globalContext.website.ampUrl = this.siteConfig.domain + '/amp/' + pagePart + '/' + currentPage + '/';
                } else {
                    globalContext.website.pageUrl = this.siteConfig.domain + '/';
                    globalContext.website.ampUrl = this.siteConfig.domain + '/amp/';
                }

                if (!this.siteConfig.advanced.ampIsEnabled) {
                    globalContext.website.ampUrl = '';
                }

                if (offset > 0) {
                    if (globalContext.context.indexOf('pagination') === -1) {
                        globalContext.context.push('pagination');
                    }

                    if (globalContext.context.indexOf('index-pagination') === -1) {
                        globalContext.context.push('index-pagination');
                    }
                }

                this.menuContext = ['frontpage'];
                let output = this.renderTemplate(compiledTemplate, context, globalContext, inputFile);

                if (offset === 0) {
                    this.templateHelper.saveOutputFile('index.html', output);
                } else {
                    // We increase the current page number as we need to start URLs from page/2
                    this.templateHelper.saveOutputHomePaginationFile(currentPage, output);
                }
            }
        }
        console.timeEnd(ampMode ? 'HOME-AMP' : 'HOME');
    }

    /*
     * Create post sites
     */
    generatePosts(ampMode = false) {
        console.time(ampMode ? 'POSTS-AMP' : 'POSTS');
        let postIDs = [];
        let postSlugs = [];
        let postTemplates = [];
        let inputFile = ampMode ? 'amp-post.hbs' : 'post.hbs';

        // Get posts
        let postData = this.db.exec(`
            SELECT
                id,
                slug,
                template
            FROM
                posts
            WHERE
                status LIKE "%published%" AND
                status NOT LIKE "%trashed%"
            ORDER BY
                id ASC
        `);

        postIDs = postData[0] ? postData[0].values.map(col => col[0]) : [];
        postSlugs = postData[0] ? postData[0].values.map(col => col[1]) : [];
        postTemplates = postData[0] ? postData[0].values.map(col => col[2]) : [];

        // Load templates
        let compiledTemplates = {};
        compiledTemplates['DEFAULT'] = this.compileTemplate(inputFile);

        if (!compiledTemplates['DEFAULT']) {
            return false;
        }

        if (!ampMode) {
            for (let i = 0; i < postTemplates.length; i++) {
                let fileSlug = postTemplates[i];

                // When we meet default template - skip the compilation process
                if (fileSlug === '' || !this.themeConfig.postTemplates[fileSlug]) {
                    continue;
                }

                compiledTemplates[fileSlug] = this.compileTemplate('post-' + fileSlug + '.hbs');

                if (!compiledTemplates[fileSlug]) {
                    return false;
                }
            }
        }

        // Create global context
        let globalContext = this.createGlobalContext('post');
        let progressIncrease = 40 / postIDs.length;

        if(ampMode) {
            progressIncrease = 7 / postIDs.length;
        }

        // Render post sites
        for (let i = 0; i < postIDs.length; i++) {
            globalContext.context = ['post'];
            let contextGenerator = new RendererContextPost(this);
            let context = contextGenerator.getContext(postIDs[i]);
            let fileSlug = 'DEFAULT';

            if (!ampMode) {
                fileSlug = postTemplates[i] === '' ? 'DEFAULT' : postTemplates[i];
            }

            this.menuContext = ['post', postSlugs[i]];
            globalContext.website.pageUrl = this.siteConfig.domain + '/' + postSlugs[i] + '.html';
            globalContext.website.ampUrl = this.siteConfig.domain + '/amp/' + postSlugs[i] + '.html';

            if (this.siteConfig.advanced.urls.cleanUrls) {
                globalContext.website.pageUrl = this.siteConfig.domain + '/' + postSlugs[i] + '/';
                globalContext.website.ampUrl = this.siteConfig.domain + '/amp/' + postSlugs[i] + '/';
            }

            globalContext.config.post = this.cachedItems.posts[postIDs[i]].postViewConfig;

            if (!this.siteConfig.advanced.ampIsEnabled) {
                globalContext.website.ampUrl = '';
            }

            let ampPrefix = ampMode ? 'amp-' : '';

            if (!compiledTemplates[fileSlug]) {
                fileSlug = 'DEFAULT';
            }

            inputFile = inputFile.replace('.hbs', '') + ampPrefix + (fileSlug === 'DEFAULT' ? '' : '-' + fileSlug) + '.hbs';
            let output = this.renderTemplate(compiledTemplates[fileSlug], context, globalContext, inputFile);

            this.templateHelper.saveOutputPostFile(postSlugs[i], output);

            if(ampMode) {
                this.sendProgress(Math.ceil(90 + (progressIncrease * i)), 'Generating posts (' + (i + 1) + '/' + postIDs.length + ')');
            } else {
                this.sendProgress(Math.ceil(20 + (progressIncrease * i)), 'Generating posts (' + (i + 1) + '/' + postIDs.length + ')');
            }
        }
        console.timeEnd(ampMode ? 'POSTS-AMP' : 'POSTS');
    }

    /*
     * Create post preview
     */
    generatePost() {
        let postID = this.postID;
        let postSlug = 'preview';
        let postTemplate = this.postData.template;
        let inputFile = 'post.hbs';

        // Load templates
        let compiledTemplates = {};
        compiledTemplates['DEFAULT'] = this.compileTemplate(inputFile);

        if(!compiledTemplates['DEFAULT']) {
            return false;
        }

        if(typeof postTemplate === "string" && postTemplate !== '') {
            postTemplate = [postTemplate];
        }

        for (let i = 0; i < postTemplate.length; i++) {
            let fileSlug = postTemplate[i];

            // When we meet default template - skip the compilation process
            if (fileSlug === '') {
                continue;
            }

            compiledTemplates[fileSlug] = this.compileTemplate('post-' + fileSlug + '.hbs');

            if(!compiledTemplates[fileSlug]) {
                return false;
            }
        }

        // Create global context
        let globalContext = this.createGlobalContext('post');

        // Render post site
        let contextGenerator = new RendererContextPostPreview(this);
        let context = contextGenerator.getContext(postID);
        let fileSlug = 'DEFAULT';
        fileSlug = postTemplate === '' ? 'DEFAULT' : postTemplate;

        this.menuContext = ['post', postSlug];
        globalContext.website.pageUrl = this.siteConfig.domain + '/' + postSlug + '.html';
        globalContext.website.ampUrl = this.siteConfig.domain + '/amp/' + postSlug + '.html';
        globalContext.config.post = this.overridePostViewSettings(JSON.parse(JSON.stringify(this.themeConfig.postConfig)), postID, true);

        if(!this.siteConfig.advanced.ampIsEnabled) {
            globalContext.website.ampUrl = '';
        }

        if(!compiledTemplates[fileSlug]) {
            fileSlug = 'DEFAULT';
        }

        inputFile = inputFile.replace('.hbs', '') + (fileSlug === 'DEFAULT' ? '' : '-' + fileSlug) + '.hbs';
        let output = this.renderTemplate(compiledTemplates[fileSlug], context, globalContext, inputFile);
        this.templateHelper.saveOutputFile(postSlug + '.html', output);
    }

    /*
     * Override post view settings with the settings of the posts
     */
    overridePostViewSettings(defaultPostViewConfig, postID, postPreview = false) {
        let postViewData = false;
        let postViewSettings = false;

        if(postPreview) {
            postViewSettings = this.postData.postViewSettings;
        } else {
            postViewData = this.db.exec(`
                SELECT
                    value
                FROM
                    posts_additional_data
                WHERE
                    post_id = ${postID}
                    AND
                    key = "postViewSettings"
            `);

            postViewSettings = postViewData[0] ? JSON.parse(postViewData[0].values[0]) : {};
        }

        return PostViewSettingsHelper.override(postViewSettings, defaultPostViewConfig);
    }

    /*
     * Generate tag pages
     */
    generateTags(ampMode = false) {
        console.time(ampMode ? 'TAGS-AMP' : 'TAGS');
        // Get tags
        let inputFile = ampMode ? 'amp-tag.hbs' : 'tag.hbs';
        let tagsData = this.db.exec(`
            SELECT
                t.id AS id
            FROM
                tags AS t
            ORDER BY
                name ASC
        `);
        tagsData = tagsData[0] ? tagsData[0].values : [];
        tagsData = tagsData.map(tag => this.cachedItems.tags[tag[0]]);

        // Remove empty tags - without posts
        if (!this.siteConfig.advanced.displayEmptyTags) {
            tagsData = tagsData.filter(tagData => {
                return tagData.postsNumber > 0;
            });
        }

        // Simplify the structure - change arrays into single value
        let tagIDs = tagsData.map(tagData => tagData.id);
        let tagSlugs = tagsData.map(tagData => tagData.slug);
        let tagTemplates = tagsData.map(tagData => {
            if (!tagData.additionalData) {
                return 'DEFAULT';
            }

            if (tagData.additionalData.template) {
                if (tagData.additionalData.template === '' || !this.themeConfig.tagTemplates[tagData.additionalData.template]) {
                    return 'DEFAULT';
                } else {
                    return tagData.additionalData.template;
                }
            }

            return 'DEFAULT';
        });

        // Load templates
        let compiledTemplates = {};
        compiledTemplates['DEFAULT'] = this.compileTemplate(inputFile);

        if (!compiledTemplates['DEFAULT']) {
            return false;
        }

        if (!ampMode) {
            for (let i = 0; i < tagTemplates.length; i++) {
                let fileSlug = tagTemplates[i];

                // When we meet default template - skip the compilation process
                if (fileSlug === '' || fileSlug === 'DEFAULT') {
                    continue;
                }

                compiledTemplates[fileSlug] = this.compileTemplate('tag-' + fileSlug + '.hbs');

                if (!compiledTemplates[fileSlug]) {
                    return false;
                }
            }
        }

        // Create global context
        let globalContext = this.createGlobalContext('tag');
        let progressIncrease = 10 / tagsData.length;

        if(ampMode) {
            progressIncrease = 2 / tagsData.length;
        }

        // Render tag sites
        for (let i = 0; i < tagsData.length; i++) {
            globalContext.context = ['tag'];
            let contextGenerator = new RendererContextTag(this);
            let fileSlug = 'DEFAULT';

            if (!ampMode) {
                fileSlug = tagTemplates[i] === '' ? 'DEFAULT' : tagTemplates[i];
            }

            // Detect if we have enough posts to create pagination
            let totalNumberOfPosts = this.cachedItems.tags[tagIDs[i]].postsNumber;
            let postsPerPage = parseInt(this.themeConfig.config.tagsPostsPerPage, 10);
            let tagSlug = URLHelper.createSlug(tagSlugs[i]);

            if (isNaN(postsPerPage)) {
                postsPerPage = 5;
            }

            if (totalNumberOfPosts <= postsPerPage || postsPerPage <= 0) {
                let context = contextGenerator.getContext(tagIDs[i], 0, postsPerPage);

                this.menuContext = ['tag', tagSlug];
                globalContext.website.pageUrl = this.siteConfig.domain + '/' + tagSlug + '/';
                globalContext.website.ampUrl = this.siteConfig.domain + '/amp/' + tagSlug + '/';

                if (this.siteConfig.advanced.urls.tagsPrefix !== '') {
                    globalContext.website.pageUrl = this.siteConfig.domain + '/' + this.siteConfig.advanced.urls.tagsPrefix + '/' + tagSlug + '/';
                    globalContext.website.ampUrl = this.siteConfig.domain + '/amp/' + this.siteConfig.advanced.urls.tagsPrefix + '/' + tagSlug + '/';
                }

                globalContext.renderer.isFirstPage = true;
                globalContext.renderer.isLastPage = true;
                globalContext.pagination = false;

                if (!this.siteConfig.advanced.ampIsEnabled) {
                    globalContext.website.ampUrl = '';
                }

                if (!compiledTemplates[fileSlug]) {
                    fileSlug = 'DEFAULT';
                }

                inputFile = inputFile.replace('.hbs', '') + (fileSlug === 'DEFAULT' ? '' : '-' + fileSlug) + '.hbs';
                let output = this.renderTemplate(compiledTemplates[fileSlug], context, globalContext, inputFile);
                this.templateHelper.saveOutputTagFile(tagSlug, output);
            } else {
                let addIndexHtml = this.previewMode || this.siteConfig.advanced.urls.addIndex;

                // If user set postsPerPage field to -1 - set it for calculations to 999
                postsPerPage = postsPerPage == -1 ? 999 : postsPerPage;

                for (let offset = 0; offset < totalNumberOfPosts; offset += postsPerPage) {
                    globalContext.context = ['tag'];
                    let context = contextGenerator.getContext(tagIDs[i], offset, postsPerPage);

                    // Add pagination data to the global context
                    let currentPage = 1;
                    let totalPages = 0;

                    if (postsPerPage > 0) {
                        currentPage = parseInt(offset / postsPerPage, 10) + 1;
                        totalPages = Math.ceil(totalNumberOfPosts / postsPerPage);
                    }

                    let nextPage = (currentPage < totalPages) ? currentPage + 1 : false;
                    let previousPage = (currentPage > 1) ? currentPage - 1 : false;
                    let tagsContextInUrl = tagSlug;

                    if (this.siteConfig.advanced.urls.tagsPrefix !== '') {
                        tagsContextInUrl = this.siteConfig.advanced.urls.tagsPrefix + '/' + tagSlug;
                    }

                    globalContext.pagination = {
                        context: tagsContextInUrl,
                        pages: Array.from({length: totalPages}, (v, k) => k + 1),
                        totalPosts: totalNumberOfPosts,
                        totalPages: totalPages,
                        currentPage: currentPage,
                        postsPerPage: postsPerPage,
                        nextPage: nextPage,
                        previousPage: previousPage,
                        nextPageUrl: URLHelper.createPaginationPermalink(this.siteConfig.domain, this.siteConfig.advanced.urls, nextPage, 'tag', tagSlug, addIndexHtml),
                        previousPageUrl: URLHelper.createPaginationPermalink(this.siteConfig.domain, this.siteConfig.advanced.urls, previousPage, 'tag', tagSlug, addIndexHtml)
                    };

                    globalContext.renderer.isFirstPage = currentPage === 1;
                    globalContext.renderer.isLastPage = currentPage === totalPages;

                    if (offset > 0) {
                        if (globalContext.context.indexOf('pagination') === -1) {
                            globalContext.context.push('pagination');
                        }

                        if (globalContext.context.indexOf('tag-pagination') === -1) {
                            globalContext.context.push('tag-pagination');
                        }
                    }

                    this.menuContext = ['tag', tagSlug];

                    if (currentPage > 1) {
                        let pagePart = this.siteConfig.advanced.urls.pageName;
                        globalContext.website.pageUrl = this.siteConfig.domain + '/' + tagSlug + '/' + pagePart + '/' + currentPage + '/';
                        globalContext.website.ampUrl = this.siteConfig.domain + '/amp/' + tagSlug + '/' + pagePart + '/' + currentPage + '/';

                        if (this.siteConfig.advanced.urls.tagsPrefix !== '') {
                            globalContext.website.pageUrl = this.siteConfig.domain + '/' + this.siteConfig.advanced.urls.tagsPrefix + '/' + tagSlug + '/' + pagePart + '/' + currentPage + '/';
                            globalContext.website.ampUrl = this.siteConfig.domain + '/amp/' + this.siteConfig.advanced.urls.tagsPrefix + '/' + tagSlug + '/' + pagePart + '/' + currentPage + '/';
                        }
                    } else {
                        globalContext.website.pageUrl = this.siteConfig.domain + '/' + tagSlug + '/';
                        globalContext.website.ampUrl = this.siteConfig.domain + '/amp/' + tagSlug + '/';

                        if (this.siteConfig.advanced.urls.tagsPrefix !== '') {
                            globalContext.website.pageUrl = this.siteConfig.domain + '/' + this.siteConfig.advanced.urls.tagsPrefix + '/' + tagSlug + '/';
                            globalContext.website.ampUrl = this.siteConfig.domain + '/amp/' + this.siteConfig.advanced.urls.tagsPrefix + '/' + tagSlug + '/';
                        }
                    }

                    if (!this.siteConfig.advanced.ampIsEnabled) {
                        globalContext.website.ampUrl = '';
                    }

                    if (!compiledTemplates[fileSlug]) {
                        fileSlug = 'DEFAULT';
                    }

                    inputFile = inputFile.replace('.hbs', '') + (fileSlug === 'DEFAULT' ? '' : '-' + fileSlug) + '.hbs';
                    let output = this.renderTemplate(compiledTemplates[fileSlug], context, globalContext, inputFile);

                    if (offset === 0) {
                        this.templateHelper.saveOutputTagFile(tagSlug, output);
                    } else {
                        // We increase the current page number as we need to start URLs from tag-slug/page/2
                        this.templateHelper.saveOutputTagPaginationFile(tagSlug, currentPage, output);
                    }
                }
            }

            if(ampMode) {
                this.sendProgress(Math.ceil(97 + (progressIncrease * i)), 'Generating tag pages (' + (i+1) + '/' + tagIDs.length + ')');
            } else {
                this.sendProgress(Math.ceil(60 + (progressIncrease * i)), 'Generating tag pages (' + (i + 1) + '/' + tagIDs.length + ')');
            }
        }
        console.timeEnd(ampMode ? 'TAGS-AMP' : 'TAGS');
    }

    /*
     * Generate author pages
     */
    generateAuthors(ampMode = false) {
        console.time(ampMode ? 'AUTHORS-AMP' : 'AUTHORS');
        // Create directory for authors
        let authorsDirPath = path.join(this.outputDir, this.siteConfig.advanced.urls.authorsPrefix);
        fs.mkdirSync(authorsDirPath);

        // Get authors
        let authorsIDs = [];
        let authorsUsernames = [];
        let inputFile = ampMode ? 'amp-author.hbs' : 'author.hbs';
        let authorTemplates = [];
        let authorsData = this.db.exec(`
            SELECT
                a.id AS id,
                a.username AS slug,
                a.config AS config,
                a.additional_data AS additional_data,
                COUNT(p.id) AS posts_number
            FROM
                authors AS a
            LEFT JOIN
                posts AS p
            ON
                CAST(p.authors AS INTEGER) = a.id
            GROUP BY
                a.id
            ORDER BY
                a.username ASC
        `);
        authorsData = authorsData[0] ? authorsData[0].values : [];
        authorsData = authorsData.map(authorData => {
            try {
                authorData[2] = JSON.parse(authorData[2]);
            } catch (e) {
                authorData[2] = '';
                console.log('[WARNING] Wrong author #' + authorData[0] + ' config - invalid JSON value');
            }

            return authorData;
        });

        // Remove empty authors - without posts
        if (!this.siteConfig.advanced.displayEmptyAuthors) {
            authorsData = authorsData.filter(authorData => {
                return authorData[4] > 0;
            });
        }

        // Simplify the structure - change arrays into single value
        authorsIDs = authorsData.map(authorData => authorData[0]);
        authorsUsernames = authorsData.map(authorData => authorData[1]);
        authorTemplates = authorsData.map(authorData => {
            if (authorData[2] && authorData[2].template) {
                if (authorData[2].template === '' || !this.themeConfig.authorTemplates[authorData[2].template]) {
                    return 'DEFAULT';
                } else {
                    return authorData[2].template;
                }
            }

            return 'DEFAULT';
        });


        // Load templates
        let compiledTemplates = {};
        compiledTemplates['DEFAULT'] = this.compileTemplate(inputFile);

        if (!compiledTemplates['DEFAULT']) {
            return false;
        }

        if (!ampMode) {
            for (let i = 0; i < authorTemplates.length; i++) {
                let fileSlug = authorTemplates[i];

                // When we meet default template - skip the compilation process
                if (fileSlug === '' || fileSlug === 'DEFAULT') {
                    continue;
                }

                compiledTemplates[fileSlug] = this.compileTemplate('author-' + fileSlug + '.hbs');

                if (!compiledTemplates[fileSlug]) {
                    return false;
                }
            }
        }

        // Create global context
        let globalContext = this.createGlobalContext('author');

        // Render author sites
        for (let i = 0; i < authorsData.length; i++) {
            globalContext.context = ['author'];
            let contextGenerator = new RendererContextAuthor(this);
            let fileSlug = 'DEFAULT';

            if (!ampMode) {
                fileSlug = authorTemplates[i] === '' ? 'DEFAULT' : authorTemplates[i];
            }

            // Detect if we have enough posts to create pagination
            let totalNumberOfPosts = this.cachedItems.authors[authorsIDs[i]].postsNumber;
            let postsPerPage = parseInt(this.themeConfig.config.authorsPostsPerPage, 10);
            let authorUsername = URLHelper.createSlug(authorsUsernames[i]);

            if (isNaN(postsPerPage)) {
                postsPerPage = 5;
            }

            if (totalNumberOfPosts <= postsPerPage || postsPerPage <= 0) {
                let context = contextGenerator.getContext(authorsIDs[i], 0, postsPerPage);

                this.menuContext = ['author', authorUsername];
                globalContext.website.pageUrl = this.siteConfig.domain + '/' + this.siteConfig.advanced.urls.authorsPrefix + '/' + authorUsername + '/';
                globalContext.website.ampUrl = this.siteConfig.domain + '/amp/' + this.siteConfig.advanced.urls.authorsPrefix + '/' + authorUsername + '/';
                globalContext.renderer.isFirstPage = true;
                globalContext.renderer.isLastPage = true;
                globalContext.pagination = false;

                if (!this.siteConfig.advanced.ampIsEnabled) {
                    globalContext.website.ampUrl = '';
                }

                if (!compiledTemplates[fileSlug]) {
                    fileSlug = 'DEFAULT';
                }

                inputFile = inputFile.replace('.hbs', '') + (fileSlug === 'DEFAULT' ? '' : '-' + fileSlug) + '.hbs';
                let output = this.renderTemplate(compiledTemplates[fileSlug], context, globalContext, inputFile);
                this.templateHelper.saveOutputAuthorFile(authorUsername, output);
            } else {
                let addIndexHtml = this.previewMode || this.siteConfig.advanced.urls.addIndex;

                // If user set postsPerPage field to -1 - set it for calculations to 999
                postsPerPage = postsPerPage == -1 ? 999 : postsPerPage;

                for (let offset = 0; offset < totalNumberOfPosts; offset += postsPerPage) {
                    globalContext.context = ['author'];
                    let context = contextGenerator.getContext(authorsIDs[i], offset, postsPerPage);

                    // Add pagination data to the global context
                    let currentPage = 1;
                    let totalPages = 0;

                    if (postsPerPage > 0) {
                        currentPage = parseInt(offset / postsPerPage, 10) + 1;
                        totalPages = Math.ceil(totalNumberOfPosts / postsPerPage);
                    }

                    let nextPage = (currentPage < totalPages) ? currentPage + 1 : false;
                    let previousPage = (currentPage > 1) ? currentPage - 1 : false;
                    let authorsContextInUrl = this.siteConfig.advanced.urls.authorsPrefix + '/' + authorUsername;

                    globalContext.pagination = {
                        context: authorsContextInUrl,
                        pages: Array.from({length: totalPages}, (v, k) => k + 1),
                        totalPosts: totalNumberOfPosts,
                        totalPages: totalPages,
                        currentPage: currentPage,
                        postsPerPage: postsPerPage,
                        nextPage: nextPage,
                        previousPage: previousPage,
                        nextPageUrl: URLHelper.createPaginationPermalink(this.siteConfig.domain, this.siteConfig.advanced.urls, nextPage, 'author', authorUsername, addIndexHtml),
                        previousPageUrl: URLHelper.createPaginationPermalink(this.siteConfig.domain, this.siteConfig.advanced.urls, previousPage, 'author', authorUsername, addIndexHtml)
                    };

                    globalContext.renderer.isFirstPage = currentPage === 1;
                    globalContext.renderer.isLastPage = currentPage === totalPages;

                    if (offset > 0) {
                        if (globalContext.context.indexOf('pagination') === -1) {
                            globalContext.context.push('pagination');
                        }

                        if (globalContext.context.indexOf('author-pagination') === -1) {
                            globalContext.context.push('author-pagination');
                        }
                    }

                    this.menuContext = ['author', authorUsername];

                    if (currentPage > 1) {
                        let pagePart = this.siteConfig.advanced.urls.pageName;
                        globalContext.website.pageUrl = this.siteConfig.domain + '/' + this.siteConfig.advanced.urls.authorsPrefix + '/' + authorUsername + '/' + pagePart + '/' + currentPage + '/';
                        globalContext.website.ampUrl = this.siteConfig.domain + '/amp/' + this.siteConfig.advanced.urls.authorsPrefix + '/' + authorUsername + '/' + pagePart + '/' + currentPage + '/';
                    } else {
                        globalContext.website.pageUrl = this.siteConfig.domain + '/' + this.siteConfig.advanced.urls.authorsPrefix + '/' + authorUsername + '/';
                        globalContext.website.ampUrl = this.siteConfig.domain + '/amp/' + this.siteConfig.advanced.urls.authorsPrefix + '/' + authorUsername + '/';
                    }

                    if (!this.siteConfig.advanced.ampIsEnabled) {
                        globalContext.website.ampUrl = '';
                    }

                    if (!compiledTemplates[fileSlug]) {
                        fileSlug = 'DEFAULT';
                    }

                    inputFile = inputFile.replace('.hbs', '') + (fileSlug === 'DEFAULT' ? '' : '-' + fileSlug) + '.hbs';
                    let output = this.renderTemplate(compiledTemplates[fileSlug], context, globalContext, inputFile);

                    if (offset === 0) {
                        this.templateHelper.saveOutputAuthorFile(authorUsername, output);
                    } else {
                        // We increase the current page number as we need to start URLs from /authors/author-username/page/2
                        this.templateHelper.saveOutputAuthorPaginationFile(authorUsername, currentPage, output);
                    }
                }
            }
        }
        console.timeEnd(ampMode ? 'AUTHORS-AMP' : 'AUTHORS');
    }

    /*
     * Generate the 404 error page (if supported in the theme)
     */
    generate404s() {
        console.time("404");
        // Check if the page should be rendered
        if (!this.themeConfig.renderer.create404page) {
            return;
        }

        // Load template
        let inputFile = '404.hbs';
        let template = this.templateHelper.loadTemplate(inputFile);
        let compiledTemplate = this.compileTemplate(inputFile);

        if (!compiledTemplate) {
            return false;
        }

        // Create global context
        let globalContext = this.createGlobalContext('404');

        // Render index site
        let contextGenerator = new RendererContext404(this);
        let context = contextGenerator.getContext();

        this.menuContext = ['404'];
        globalContext.website.pageUrl = this.siteConfig.domain + '/';
        globalContext.website.ampUrl = '';
        globalContext.renderer.isFirstPage = true;
        globalContext.renderer.isLastPage = true;

        let output = this.renderTemplate(compiledTemplate, context, globalContext, inputFile);
        this.templateHelper.saveOutputFile(this.siteConfig.advanced.urls.errorPage, output);
        console.timeEnd("404");
    }

    /*
     * Generate the 404 error page (if supported in the theme)
     */
    generateSearch() {
        console.time("SEARCH");
        // Check if the page should be rendered
        if(!this.themeConfig.renderer.createSearchPage) {
            return;
        }

        // Load template
        let inputFile = 'search.hbs';
        let compiledTemplate = this.compileTemplate('search.hbs');

        if(!compiledTemplate) {
            return false;
        }

        // Create global context
        let globalContext = this.createGlobalContext('search');

        // Render index site
        let contextGenerator = new RendererContextSearch(this);
        let context = contextGenerator.getContext();

        this.menuContext = ['search'];
        globalContext.website.pageUrl = this.siteConfig.domain + '/';
        globalContext.website.ampUrl = '';
        globalContext.renderer.isFirstPage = true;
        globalContext.renderer.isLastPage = true;

        let output = this.renderTemplate(compiledTemplate, context, globalContext, inputFile);
        this.templateHelper.saveOutputFile(this.siteConfig.advanced.urls.searchPage, output);
        console.timeEnd("SEARCH");
    }

    /*
     * Create the override.css file and merge it with main.css file
     */
    generateCSS() {
        console.time('CSS');
        let overridePath = path.join(this.themeDir, 'visual-override.js');
        let overridedOverridePath = UtilsHelper.fileIsOverrided(this.themeDir, overridePath);

        if(overridedOverridePath) {
            overridePath = overridedOverridePath;
        }

        let cssPath = path.join(this.themeDir, this.themeConfig.files.assetsPath, 'css', 'main.css');
        let overridedCssPath = UtilsHelper.fileIsOverrided(this.themeDir, cssPath);

        if(overridedCssPath) {
            cssPath = overridedCssPath;
        }

        let mainCSSContent = fs.readFileSync(cssPath, 'utf8');
        let styleCSS = mainCSSContent;
        let newFileName = path.join(this.themeDir, this.themeConfig.files.assetsPath, 'css', 'style.css');
        let overridedNewFileName = UtilsHelper.fileIsOverrided(this.themeDir, newFileName);

        if(overridedNewFileName) {
            newFileName = overridedNewFileName;
        }

        // Add GDPR popup CSS code if used
        if (this.siteConfig.advanced.gdpr.enabled) {
            styleCSS += Gdpr.popupCssOutput();
        }

        let customCSSPath = path.join(this.sitesDir, this.siteName, 'input', 'config', 'custom-css.css');

        // check if the theme contains visual-override.js file
        if(UtilsHelper.fileExists(overridePath)) {
            try {
                let generateOverride = this.requireWithNoCache(overridePath);
                let visualParams = JSON.parse(JSON.stringify(this.themeConfig.customConfig));
                styleCSS += generateOverride(visualParams);
            } catch(e) {
                this.errorLog.push({
                    message: 'An error (1003) occurred during preparing CSS overrides.',
                    desc: e.message
                });
            }
        }

        if(UtilsHelper.fileExists(customCSSPath)) {
            styleCSS += fs.readFileSync(customCSSPath, 'utf8');
        }

        // minify CSS if user enabled it
        if(this.siteConfig.advanced.cssCompression === 1) {
            styleCSS = new CleanCSS({ compatibility: '*' }).minify(styleCSS);
            styleCSS = styleCSS.styles;
        }

        fs.writeFileSync(newFileName, styleCSS, {'flags': 'w'});
        console.timeEnd('CSS');
    }

    /*
     * Create feeds
     */
    generateFeeds() {
        console.time('FEEDS');
        this.generateFeed('xml');
        this.generateFeed('json');
        console.timeEnd('FEEDS');
    }

    /*
     * Create XML/JSON feed file
     */
    generateFeed(format = 'xml') {
        let compiledTemplate = this.compileTemplate('feed-' + format + '.hbs');

        if(!compiledTemplate) {
            return false;
        }

        // Render feed view
        let contextGenerator = new RendererContextFeed(this);
        let numberOfPosts = this.siteConfig.advanced.feed.numberOfPosts;

        if(typeof numberOfPosts === "undefined") {
            numberOfPosts = 10;
        }

        let context = contextGenerator.getContext(numberOfPosts);
        let output = this.renderTemplate(compiledTemplate, context, false, 'feed-' + format + '.hbs');
        this.templateHelper.saveOutputFile('feed.' + format, output);
    }

    async generateSitemap() {
        if(!this.siteConfig.advanced.sitemapEnabled) {
            return;
        }

        console.time("SITEMAP");
        let sitemapGenerator = new Sitemap(this.outputDir, this.siteConfig, this.themeConfig);
        await sitemapGenerator.create();
        console.timeEnd("SITEMAP");
    }

    generateAMP() {
        if(!this.siteConfig.advanced.ampIsEnabled) {
            return;
        }

        console.time("AMP");
        // Prepared directory
        fs.mkdirSync(path.join(this.outputDir, 'amp'));
        // Enable amp mode
        this.ampMode = true;
        // Change template helper output dir
        this.outputDir = path.join(this.outputDir, 'amp');
        this.templateHelper.outputDir = path.join(this.templateHelper.outputDir, 'amp');
        // Extend domain with /amp/ directory
        this.siteConfig.domain += '/amp';
        // Regenerate data for AMP mode
        this.loadContentStructure();
        // Prepare files
        this.generateFrontpage(true);
        this.generatePosts(true);
        this.generateTags(true);
        this.generateAuthors(true);
        console.timeEnd("AMP");
    }

    /**
     * Copy input files to the output directory
     */
    copyFiles() {
        console.time("FILES");
        FilesHelper.copyRootFiles(this.inputDir, this.outputDir);
        FilesHelper.copyAssetsFiles(this.themeDir, this.outputDir, this.themeConfig);
        FilesHelper.copyMediaFiles(this.inputDir, this.outputDir);
        console.timeEnd("FILES");
    }

    loadContentStructure() {
        console.time("CONTENT DATA");
        let globalContextGenerator = new RendererContext(this);
        this.cachedItems = {
            postTags: {},
            posts: {},
            tags: {},
            tagsPostCounts: {},
            authors: {},
            authorsPostCounts: {},
            featuredImages: {}
        };
        globalContextGenerator.getCachedItems();
        this.contentStructure = globalContextGenerator.getContentStructure();
        console.timeEnd("CONTENT DATA");
    }

    loadCommonData() {
        console.time("COMMON DATA");
        let globalContextGenerator = new RendererContext(this);
        let menusData = globalContextGenerator.getMenus();

        this.commonData = {
            tags: globalContextGenerator.getAllTags(),
            authors: globalContextGenerator.getAuthors(),
            menus: menusData.assigned,
            unassignedMenus: menusData.unassigned,
            featuredPosts: {
                homepage: globalContextGenerator.getFeaturedPosts('homepage'),
                tag: globalContextGenerator.getFeaturedPosts('tag'),
                author: globalContextGenerator.getFeaturedPosts('author')
            },
            hiddenPosts: globalContextGenerator.getHiddenPosts()
        };
        console.time("COMMON DATA");
    }

    createGlobalContext(context) {
        let globalContextGenerator = new RendererContext(this);
        let globalContext = globalContextGenerator.getGlobalContext();
        globalContext.context = [context];
        globalContext.config = URLHelper.prepareSettingsImages(this.siteConfig.domain, {
            basic: JSON.parse(JSON.stringify(this.themeConfig.config)),
            custom: JSON.parse(JSON.stringify(this.themeConfig.customConfig))
        });
        globalContext.website.language = this.siteConfig.language;
        globalContext.website.contentStructure = this.contentStructure;

        return globalContext;
    }

    compileTemplate(inputFile) {
        let compiledTemplate = false;
        let template = this.templateHelper.loadTemplate(inputFile);

        if((inputFile === 'feed-xml.hbs' || inputFile === 'feed-json.hbs') && !template) {
            // Load default feed.hbs file if it not exists inside the theme directory
            let feedPath = path.join(__dirname, '..', '..', '..', 'default-files', 'theme-files', inputFile);
            template = fs.readFileSync(feedPath, 'utf8');
        }

        if(!template) {
            this.errorLog.push({
                message: 'File ' + inputFile + ' does not exist.',
                desc: ''
            });
        }

        try {
            compiledTemplate = Handlebars.compile(template);
        } catch(e) {
            this.errorLog.push({
                message: 'An error (1001) occurred during parsing ' + inputFile + ' file.',
                desc: e.message
            });

            return false;
        }

        return compiledTemplate;
    }

    renderTemplate(compiledTemplate, context, globalContext, inputFile) {
        let output = '';

        try {
            output = compiledTemplate(context, {
                data: globalContext
            });
        } catch(e) {
            this.errorLog.push({
                message: 'An error (1002) occurred during parsing ' + inputFile + ' file.',
                desc: e.message
            });

            return '';
        }

        return output;
    }

    requireWithNoCache(module, params = false) {
        delete require.cache[require.resolve(module)];

        if (params) {
            return require(module)(params);
        }

        return require(module);
    }
}

module.exports = Renderer;
