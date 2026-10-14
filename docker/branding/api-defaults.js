
/*
 * Officier corporate defaults, appended to ONLYOFFICE api.js at image build.
 * Modified on October 13, 2026: hides ONLYOFFICE branding in the editors and
 * keeps the Appropriate Legal Notices in File > About (LICENSE, Additional Terms 3).
 */
(function (DocsAPI, document) {
    'use strict';

    var branding = /*OFFICIER_BRANDING*/null;
    // Cache-tagged path prefix of the editor files ("/9.4.0-<tag>"), filled in at container start.
    var cachePath = /*OFFICIER_CACHE_PATH*/'';
    var Original = DocsAPI && DocsAPI.DocEditor;
    if (!branding || typeof Original !== 'function' || Original.officierBranding)
        return;

    var scriptSrc = document && document.currentScript && document.currentScript.src;
    var origin = scriptSrc ? new URL(scriptSrc).origin : '';

    function isObject(value) {
        return value !== null && typeof value === 'object' && !Array.isArray(value);
    }

    function setDefault(target, key, value) {
        if (target[key] === undefined)
            target[key] = value;
    }

    function applyDefaults(config) {
        var result = Object.assign({}, config);
        var editorConfig = result.editorConfig = Object.assign({}, result.editorConfig);
        var customization = editorConfig.customization = Object.assign({}, editorConfig.customization);

        // Branding policy: the integrator cannot bring ONLYOFFICE marks back.
        // No loaderName/loaderLogo: they switch to index_loader.html, which Community builds lack.
        customization.logo = {visible: false};
        customization.customer = {name: branding.productName, info: branding.legalNotice};
        if (origin)
            customization.customer.www = origin + branding.legalPage;
        customization.about = true;
        customization.help = false;
        customization.feedback = false;
        customization.suggestFeature = false;
        customization.features = Object.assign({}, isObject(customization.features) ? customization.features : {}, {featuresTips: false});

        // Corporate defaults the integrator may still override.
        setDefault(customization, 'integrationMode', 'embed');
        setDefault(customization, 'plugins', false);
        setDefault(customization, 'macros', false);
        setDefault(customization, 'mentionShare', false);

        // Plugin files are cached for a year: load our server's plugins through the cache-tagged
        // path, which changes on every server start like the editor files themselves.
        var plugins = editorConfig.plugins;
        if (origin && cachePath && cachePath.indexOf('{{') < 0 && isObject(plugins) && Array.isArray(plugins.pluginsData)) {
            editorConfig.plugins = Object.assign({}, plugins, {pluginsData: plugins.pluginsData.map(function (url) {
                return typeof url === 'string' && url.indexOf(origin + '/sdkjs-plugins/') === 0 ? origin + cachePath + url.slice(origin.length) : url;
            })});
        }

        // There is no Kazakh interface translation: use Russian UI with Kazakh regional settings.
        if (/^kk/i.test(editorConfig.lang || '')) {
            setDefault(editorConfig, 'region', 'kk-KZ');
            editorConfig.lang = 'ru';
        }
        return result;
    }

    function OfficierDocEditor(placeholderId, config) {
        return Original.call(this, placeholderId, applyDefaults(config || {}));
    }

    for (var key in Original) {
        if (Object.prototype.hasOwnProperty.call(Original, key))
            OfficierDocEditor[key] = Original[key];
    }
    OfficierDocEditor.prototype = Original.prototype;
    OfficierDocEditor.officierBranding = true;
    OfficierDocEditor.officierApplyDefaults = applyDefaults;
    DocsAPI.DocEditor = OfficierDocEditor;
})(window.DocsAPI, document);
