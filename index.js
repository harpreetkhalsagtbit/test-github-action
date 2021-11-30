var w = window;
var pageGroupTimer;
var adp = (w.adpushup = w.adpushup || {});

var utils = require('./libs/utils');
var EventLogger = require('./libs/eventLogger');
var commonConsts = require('./config/commonConsts');
var browserConfig = require('./libs/browserConfig');
var adCreater = require('./adCreater');
var hookAndInit = require('./hooksAndBlockList');
var control = require('./control')();
var adCodeGenerator = require('./adCodeGenerator');
var session = require('./libs/session');
var refreshAdSlot = require('./refreshAdSlot');
var triggerControl = require('./modules/fallbackAds/index')(control);
const ErrorHandler = require('./error/handler');

var googlFcCmp = require('./libs/googleFcCmp');

function start() {
	// requiring ./config/config.js file earlier can break code since it uses adp.$ which might not be available by then. Or we can convert the export from this file to a function if required
	let defaultAdpushupConfig = adp.$.extend({}, require('./config/config.js'));
	let config = (adp.config = adp.$.extend(true, {}, defaultAdpushupConfig));
	let previousPacketId = null;

	/**
	 * adpushup.js should run only for the authorized domains. For example a site working with adpushup might have its pages embedded as iframes inside pages from other sites (could be porn or other illegal sites), in those cases we would not want to send the adrequests to our partners. Ideally the adpushup.js must not work in that case
	 *
	 * Further a publisher may authorize some particular third party domains to embed its pages in iframes. Those domains must be added in apconfigs.authorizedDomains list in site doc in couchbase. And adpushup.js should work in that case
	 *
	 */
	const domainAuthorized =
		!config.isAuthorizedDomainCheckEnabled ||
		utils.isDomainAuthorized(config.siteDomain, config.authorizedDomains);
	if (domainAuthorized) {
		config.isDomainAuthorized = true;
	} else {
		utils.log('Un-authorized domain');
		config.isDomainAuthorized = false;

		//init and triggerAd functions can be invoked from outside our script (aptag, hook for spa), so set them to noop functions so that it desn't throw "not a function" error
		adp.init = function () {
			console &&
				console.error &&
				console.error('Un-authorized domain, adpushup can not be initialized.');
		};
		adp.triggerAd = function () {
			console && console.error && console.error('Un-authorized domain, ApTag can not be triggered');
		};

		return;
	}

	if (!SEPARATE_PREBID_DISABLED && HB_ACTIVE) {
		utils.injectHeadCodeOnPage(config.prebidBundleUrl);
	}

	if (LAYOUT_ACTIVE) {
		var processLayoutAds = require('./modules/layoutAds/index');
		var nodewatcher = require('./libs/nodeWatcher');
	}
	if (GENIEE_ACTIVE) {
		var genieeObject = require('./genieeObject');
	}
	if (SPA_ACTIVE) {
		var spaHandler = require('./spaHandler');
	}
	if (APTAG_ACTIVE) {
		var apTagModule = require('./trigger');
		var triggerAd = apTagModule.triggerAd;
		var processApTagQue = apTagModule.processApTagQue;
	} else {
		triggerAd = function () {
			console && console.error && console.error('APtag Module not enabled');
		};
	}
	if (INNOVATIVE_ADS_ACTIVE) {
		var processInnovativeAds = require('./modules/interactiveAds/index').default;
	}

	if(USER_TRACKING) {
		var userTracking = require('./userTracking');
	}

	var Tracker = require('./libs/tracker');
	// var heartBeat = require('./libs/heartBeat');
	// var ampInit = require('./ampInit');

	var isGenieeSite;
	w.adpushup.configExtended = false;
	var controlAdsTriggered;
	var isAdpushupPaused = parseInt(config.mode, 10) === commonConsts.MODE.FALLBACK;
	
	// Extend adpushup object
	adp.$.extend(adp, {
		creationProcessStarted: false,
		afterJSExecuted: false,
		err: [],
		utils: utils,
		control: control,
		tracker: new Tracker(),
		eventLogger: new EventLogger(),
		nodewatcher: nodewatcher,
		geniee: genieeObject,
		triggerAd: triggerAd,
		session: session,
		generateAdCode: adCodeGenerator.generateAdCode,
		executeAdpTagsHeadCode: adCodeGenerator.executeAdpTagsHeadCode,
		executeAfterJS: adCreater.executeAfterJS,
		stopRefreshForASlot: refreshAdSlot.stopRefreshForASlot,
		services: {
			APTAG_ACTIVE: APTAG_ACTIVE,
			INNOVATIVE_ADS_ACTIVE: INNOVATIVE_ADS_ACTIVE,
			LAYOUT_ACTIVE: LAYOUT_ACTIVE,
			ADPTAG_ACTIVE: ADPTAG_ACTIVE,
			SPA_ACTIVE: SPA_ACTIVE,
			GENIEE_ACTIVE: GENIEE_ACTIVE,
			HB_ACTIVE: HB_ACTIVE,
			GDPR_ACTIVE: GDPR_ACTIVE,
			INCONTENT_ACTIVE: INCONTENT_ACTIVE,
			AP_LITE_ACTIVE: AP_LITE_ACTIVE,
			PNP_REFRESH_ACTIVE: PNP_REFRESH_ACTIVE
		}
	});

	let shouldErrorHandlerBeEnabled = utils.shouldErrorHandlerBeEnabled(window, document);

	// add error handler instance
	w.adpushup.errorHandler = new ErrorHandler(w, shouldErrorHandlerBeEnabled);

	// Destroy ADP slots and their associated GPT slots
	function destroyAdpSlots() {
		var adpSlots = Object.keys(w.adpTags.adpSlots);

		if (adpSlots.length) {
			var adpGSlots = [];
			adpSlots.forEach(function (adpSlot) {
				var slot = w.adpTags.adpSlots[adpSlot];
				if (slot && !slot.optionalParam.isManual && slot.gSlot) {
					// remove the slot from adpSlots
					w.adpTags.adpSlots[adpSlot] = undefined;
					adpGSlots.push(slot.gSlot);
				}
			});

			// w.adpTags.adpSlots = {};
			w.googletag.cmd.push(function () {
				w.googletag.destroySlots(adpGSlots);
			});
		}
	}

	// Reset adpTags config and destroy all ADP slots
	function resetAdpTagsConfig() {
		if (w.adpTags && w.adpTags.config) {
			w.adpTags.adpBatches = [];
			w.adpTags.batchPrebiddingComplete = false;
			w.adpTags.currentBatchAdpSlots = [];
			w.adpTags.currentBatchId = null;
			w.adpTags.gptRefreshIntervals = [];
			destroyAdpSlots();
		}
	}

	// Reset adpushup config
	function resetAdpConfig() {
		previousPacketId = adp.config.packetId;
		config = adp.config = adp.$.extend(true, {}, defaultAdpushupConfig);
	}

	// Resets and initialises the adpushup config object
	function initAdpConfig() {
		return new Promise(function (resolve) {
			resetAdpConfig();
			let newPacketId = null;

			adp.$.extend(adp, {
				creationProcessStarted: false,
				afterJSExecuted: false,
				err: []
			});

			if (!previousPacketId ||  adp.config.pageUrl != window.location.href) {
				newPacketId = utils.uniqueId(defaultAdpushupConfig.siteId);
			}
			else {
				newPacketId = previousPacketId;
			}
			// Extend the settings with generated settings
			// eslint-disable-next-line no-undef
			adp.$.extend(adp.config, {
				browser: browserConfig.name,
				platform: browserConfig.platform,
				packetId: newPacketId
			});

			!adp.config.apLiteActive && resetAdpTagsConfig();

			resolve();
		}).then(function () {
			if (!w.adpushup.configExtended) {
				if (ADPTAG_ACTIVE || adp.config.apLiteActive) {
					require('./modules/adpTags/index');
				}
				if (GDPR_ACTIVE) {
					require('./modules/gdpr/index');
				}
				w.adpushup.configExtended = true;
			}
		});
	}

	// Fire user async API
	function syncUser() {
		return utils.sendBeacon(commonConsts.USER_SYNC_URL);
	}

	function startCreation(variationName, forced) {
		// ampInit(adp.config);
		var isControlVariation = false;

		function triggerLayoutAds() {
			var shouldNotRunLayoutAds =
				controlAdsTriggered ||
				!w.adpushup.services.LAYOUT_ACTIVE ||
				(forced && !variationName) ||
				(!forced && (config.disable || (!variationName && !config.pageGroup)));

			if (shouldNotRunLayoutAds) return;

			return processLayoutAds(adp, variationName).then(({ adpConfig, selectedVariation }) => {
				isControlVariation = !!selectedVariation && selectedVariation.isControl;
				config = adpConfig;

				if (!selectedVariation) {
					triggerControl(
						commonConsts.MODE.FALLBACK,
						commonConsts.ERROR_CODES.VARIATION_NOT_SELECTED
					);
					controlAdsTriggered = true;
					return;
				}

				adp.creationProcessStarted = true;
				clearTimeout(pageGroupTimer);
			});
		}

		function triggerInnovativeAds() {
			if (config.disable || !config.pageGroup) return;

			var innovativeInteractiveAds = [];

			if (w.adpushup.services.INNOVATIVE_ADS_ACTIVE && w.adpushup.config.innovativeAds.length) {
				var channel = config.platform.toUpperCase() + ':' + config.pageGroup.toUpperCase();
				innovativeInteractiveAds = utils.filterInteractiveAds(
					w.adpushup.config.innovativeAds,
					true,
					channel
				);
			}

			var shouldRunInnovativeAds = !!(
				w.adpushup.services.INNOVATIVE_ADS_ACTIVE &&
				!isControlVariation &&
				innovativeInteractiveAds &&
				innovativeInteractiveAds.length
			);

			if (!shouldRunInnovativeAds) return;

			setTimeout(() => {
				try {
					processInnovativeAds(innovativeInteractiveAds);
					adp.creationProcessStarted = true;
				} catch (e) {
					utils.log('Innovative Ads Failed', e);
				}
			});
		}

		return Promise.resolve().then(triggerLayoutAds).then(triggerInnovativeAds);
	}

	function startApLiteCreation() {
		var apLiteAdpModule = require('./modules/apLite/adp');
		apLiteAdpModule.init();
	}

	function processQue() {
		while (w.adpushup.que.length) {
			w.adpushup.que.shift().call();
		}
	}

	function initAdpQue() {
		if (w.adpushup && Array.isArray(w.adpushup.que) && w.adpushup.que.length) {
			adp.que = w.adpushup.que;
		} else {
			adp.que = [];
		}

		processQue();
		adp.que.push = function (queFunc) {
			[].push.call(w.adpushup.que, queFunc);
			processQue();
		};
	}

	function isNonAdpushupPageView() {
		if (!isNaN(config.adpushupPercentage)) {
			var rand = Math.floor(Math.random() * 100) + 1;
			return rand > config.adpushupPercentage;
		}

		return true;
	}

	//check if google funding choice is already avaialble on page
	function isGoogleFcAvailable() {
		return (
			window.googlefc &&
			window.googlefc.ConsentStatusEnum &&
			Object.keys(window.googlefc.ConsentStatusEnum).length
		);
	}

	// we need to check CMP availabilityt for European countries only
	function isCmpAplicable() {
		return Promise.resolve(
			!isGoogleFcAvailable() &&
				!commonConsts.CMP_CHECK_EXCLUDED_SITES.includes(adp.config.siteId) &&
				!adp.config.cmpAvailable &&
				commonConsts.EU_COUNTRY_LIST.includes(adp.config.country)
		);
	}

	function loadGoogleFundingChoicesCmp() {
		return googlFcCmp.loadAndInitiateCmp(() => {
			if (adp.config.renderPostBid) {
				adp.config.renderPostBid = false;
				setTimeout(() => {
					if (adp.adpTags && adp.adpTags.adpSlots) {
						adp.adpTags.reInitAfterPostBid(window);
					}
				}, 10);
			}
		});
	}

	function main() {
		// Initialise adp config
		// TODO: add a catch handler for this promise
		// TODO: can we create a window.adpushup.adpTags.que = [] at this point of time so that we can simply push fns to this que from the rest of the code
		initAdpConfig();

		// for spa, initAdpQue is called from start function
		if (!adp.config.isSPA && !adp.services.SPA_ACTIVE) {
			initAdpQue();
		}

		if (GA_ANALYTICS_ACTIVE) {
			utils.checkAndInjectGAHeadCode();
			utils.checkAndInjectUniversalGAHeadCode();
			window.adpLoadTimeStamp = Date.now();
		}

		//TO inject script required by prebid userIds
		utils.injectScriptsForPrebidUserIds(window.adpushup.config.siteId);

		utils.emitGaEvent(commonConsts.GA_EVENTS.SCRIPT_LOADED);

		const gaConfigs = window.adpushup.config.gaConfigs || {};
		const gaEventSampling = gaConfigs.gaEventSampling;
		const currentFallBack = Math.random() * 100;
		if (gaEventSampling && currentFallBack <= gaEventSampling) {
			utils.emitGa3Event(commonConsts.GA_EVENTS.SCRIPT_LOADED);
		}

		utils.logPerformanceEvent(commonConsts.EVENT_LOGGER.EVENTS.MAIN_FN_CALL_DELAY);

		// if traffic is from lighthouse and site has to be paused for lighthouse
		if (!utils.getQueryParams().stopLightHouseHack && utils.checkForLighthouse(adp.config.siteId))
			return;

		// Set user syncing cookies
		syncUser();

		// disable header bidding if query param contains `?adpushupHeaderBiddingDisabled=true`
		adp.services.HB_ACTIVE =
			adp.services.HB_ACTIVE && !utils.getQueryParams().adpushupHeaderBiddingDisabled;

		if (utils.isAdPushupForceDisabled()) {
			utils.log(`AdPushup has been forced disabled...`);
			return false;
		}

		var beforeJs = adp.config.beforeJs;

		if (beforeJs) {
			try {
				utils.runScript(utils.base64Decode(beforeJs));
			} catch (e) {
				adp.err.push({
					msg: 'Error in beforeJs.',
					js: beforeJs,
					error: e
				});
			}
		}

		if (adp.services.PNP_REFRESH_ACTIVE && !adp.services.SPA_ACTIVE) {
			// current pnp script doesn't support SPA.
			var pnpRefresh = require('./modules/pnpRefresh');
			pnpRefresh.init();
		}
		
		if(USER_TRACKING) {
			// User tracking code - moved from before js to here
			userTracking.init();
		}

		var apLiteActive = adp.config.apLiteActive;

		//for SPAs: remove any interactive ad containers, if available and apLite is disabled
		!apLiteActive && adp.$('.adp_interactive_ad').remove();

		// Initialise SPA handler
		if (adp.config.isSPA && adp.services.SPA_ACTIVE) {
			spaHandler(w, adp);
		}

		// Initialise adpushup session
		session.init();

		if (adp.config.isUrlReportingEnabled) {
			utils.fetchAndSetKeyValueForUrlReporting(adp);
		}

		//Initialise refresh slots
		refreshAdSlot.init(w);

		if (!apLiteActive) {
			//Geniee ad network specific site check
			isGenieeSite = !!(adp.config.partner && adp.config.partner === 'geniee');
			adp.config.isGeniee = isGenieeSite;
		}

		/**
		 * For European countries we need to make sure that cmp is there on the page for user consent management, before sending an ad request to Google.
		 * So, we load googleFundingChoices on the page for the user to provide consent, but initiate our HB auction alongside, in case cmp is loaded and consent is available before auction end, we send ad request to GAM else we simply render the winning bid from HB (postBidding)
		 */
		isCmpAplicable()
			.then((cmpApplicable) => {
				utils.log('cmpApplicable', cmpApplicable);
				if (cmpApplicable) {
					adp.config.renderPostBid =
						adp.config.postBidEnabled === null || adp.config.postBidEnabled === undefined
							? true
							: adp.config.postBidEnabled;
					return loadGoogleFundingChoicesCmp();
				}
				return '';
			})
			.then(() => {
				utils.log('CMP loaded');
				adp.config.cmpLoaded = true;

				// invoke processApTagQue function from trigger.js in case there has been and calls to adpushup.triggerAd from page while we were waiting for CMP check and CMP load. Use timeout so that current init function is done before apTags are processed
				setTimeout(() => {
					processApTagQue && processApTagQue();
				}, 0);
				if (!apLiteActive) {
					controlAdsTriggered = false;
					
					// Hook Pagegroup, find pageGroup and check for blockList
					hookAndInit(adp, browserConfig.platform);

					// AdPushup Debug Force Variation
					var forceVariationName =
						utils.getQueryParams && utils.getQueryParams()[config.forceVariation];
					if (forceVariationName) {
						startCreation(forceVariationName, true);
						return false;
					}

					// AdPushup Debug Force Control
					if (!controlAdsTriggered && utils.getQueryParams && utils.getQueryParams().forceControl) {
						triggerControl(commonConsts.MODE.FALLBACK, commonConsts.ERROR_CODES.FALLBACK_FORCED); // Control forced (run fallback)
						controlAdsTriggered = true;
					}

					// AdPushup Paused Logic
					if (isAdpushupPaused) {
						!controlAdsTriggered &&
						triggerControl(commonConsts.MODE.FALLBACK, commonConsts.ERROR_CODES.ADPUSHUP_PAUSED); // Adpushup Paused (run fallback)
						return false;
					}

					// AdPushup Percentage Logic
					if (isNonAdpushupPageView()) {
						!controlAdsTriggered &&
							triggerControl(commonConsts.MODE.FALLBACK, commonConsts.ERROR_CODES.FALLBACK_PLANNED); // Control planned (run fallback)
						return false;
					}

					// If disabled by URL Blocklist
					if (config.disable) {
						return false;
					}

					// AdPushup Editor Paused Logic
					if (!controlAdsTriggered && !adp.services.LAYOUT_ACTIVE) {
						triggerControl(commonConsts.MODE.FALLBACK, commonConsts.ERROR_CODES.PAUSED_IN_EDITOR); // Paused from editor (run fallback)
						controlAdsTriggered = true;
					}

					if (!config.pageGroup) {
						pageGroupTimer = setTimeout(function () {
							if (!controlAdsTriggered && !config.pageGroup) {
								triggerControl(
									commonConsts.MODE.FALLBACK,
									commonConsts.ERROR_CODES.PAGEGROUP_NOT_FOUND
								);
								controlAdsTriggered = true;
							} else {
								clearTimeout(pageGroupTimer);
							}
						}, config.pageGroupTimeout);
					} else {
						// start heartBeat
						// heartBeat(config.feedbackUrl, config.heartBeatMinInterval, config.heartBeatDelay).start();

						//Init creation
						startCreation();
					}
				}

				apLiteActive && startApLiteCreation();
			});
	}

	adp.init = function () {
		/**
		 * setting cmpLoaded = false because in case of SPA sites
		 * if ap tag is used, for 2nd adpushup.init() onwards, the
		 * check for adp.config.cmpLoaded in triggerAd() in trigger.js
		 * gets `true` from previous adpushup.init() call
		 * and directly calls trigger() instead of pushing it in the apTagQue
		 * which interfers with adpBatches and the ad doesn't get render 2nd
		 * init() call onwards. Originally this issue is noticed
		 * for https://architizer.com/idea/3287096/
		 */
		adp.config.cmpLoaded = false;
		browserConfig.detectPlatform().then(main);
	};

	/**
	 * adpushup.config.platform is set inside main()
	 * which runs after platform detection (asynchronously)
	 *
	 * So, moving the initAdpQue function inside main()
	 * so that functions pushed to adpushup.que can access
	 * the platform details
	 *
	 * However, for SPA sites, the main() is not called by us but
	 * via a function pushed to adpushup.que by the publisher
	 *
	 * So, we are calling initAdpQue conditionally to satisfy
	 * the situation
	 */
	if (!adp.config.isSPA && !adp.services.SPA_ACTIVE) {
		adp.init();
	} else {
		initAdpQue(); // Initialise adp que
	}
}

utils.injectJqueryIfDoesntExist(start);
