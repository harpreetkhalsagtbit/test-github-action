// GPT library module

var utils = require('./libs/utils'),
	commonConsts = require('./config/commonConsts'),
	adCodeGenerator = require('./adCodeGenerator'),
	{
		getBbPlayerId,
		removeBbPlayerIfRendered,
		sendBbPlayerLogs
	} = require('./modules/adpTags/bbPlayerUtils'),
	adp = window.adpushup,
	debounce = require('lodash.debounce'),
	cssescape = require('./libs/css.escape'),
	ads = [],
	inViewAds = [],
	setRefreshTimeOut = function (container, ad, refreshInterval) {
		if (container.length && utils.checkElementInViewPercent(container)) {
			var refreshInterval =
				refreshInterval !== undefined
					? refreshInterval
					: parseInt(ad.networkData.refreshInterval) * 1000 || commonConsts.AD_REFRESH_INTERVAL;

			var currentTime = new Date().getTime();
			container.attr('data-refresh-time', currentTime);

			var oldTimeoutId = container.attr('data-timeout');
			oldTimeoutId && clearTimeout(oldTimeoutId);

			var newTimeoutId = setTimeout(refreshAd, refreshInterval, ad);
			container.attr('data-timeout', newTimeoutId);
		}
	},
	getAdObjById = function (adId) {
		if (!adId) return;

		return ads.find((obj) => obj.ad.id === adId);
	},
	setRefreshTimeOutByAdId = function (adId, refreshInterval) {
		if (!adId) return;

		var adObj = getAdObjById(adId);
		if (!adObj) return;

		var container = adp.$(`#${cssescape(adId)}`);
		setRefreshTimeOut(container, adObj.ad, refreshInterval);
	},
	getRefreshDataByAdId = function (adId) {
		if (!adId) return;

		var adObj = getAdObjById(adId);
		if (!adObj) return;

		// get updated container (adObj.container is old)
		var container = adp.$(`#${cssescape(adObj.ad.id)}`);

		var { refreshTime: refreshTimeStamp, timeout: refreshTimeoutId } = container[0].dataset;

		if (!refreshTimeStamp || !refreshTimeoutId) return;

		var refreshTimeoutStartTime = new Date(parseInt(refreshTimeStamp, 10));
		var currentTime = new Date();

		var refreshIntervalInMs =
			adObj.ad.networkData.refreshInterval * 1000 || commonConsts.AD_REFRESH_INTERVAL;

		var refreshTimeLeftInMs = refreshIntervalInMs - (currentTime - refreshTimeoutStartTime);

		return {
			refreshTimeoutStartTime,
			refreshTimeLeftInMs,
			refreshTimeoutId
		};
	},
	refreshAd = function (ad) {
		var container = adp.$(`#${cssescape(ad.id)}`);

		if (container.length && utils.checkElementInViewPercent(container)) {
			var currentTime = new Date().getTime();
			container.attr('data-refresh-time', currentTime);

			var slot = window.adpushup.adpTags.adpSlots[ad.slotId];
			slot.toBeRefreshed = true;
			slot.refreshCount = typeof slot.refreshCount === 'undefined' ? 1 : ++slot.refreshCount;

			removeBidderTargeting(slot);

			if (!adp.config.isBbPlayerDisabled) {
				if (adp.config.isBbPlayerLoggingEnabled) {
					sendBbPlayerLogs('refresh', 'refreshAd', slot);

					// Temporarily logging video bids which are neither rendered nor thrown any error
					const notRenderedVideoBid =
						adp.config.notRenderedVideoBids && adp.config.notRenderedVideoBids[slot.containerId];

					if (notRenderedVideoBid) {
						sendBbPlayerLogs(
							'not_rendered_video_bid',
							'not_rendered_video_bid',
							{},
							notRenderedVideoBid
						);

						delete adp.config.notRenderedVideoBids[slot.containerId];
					}
				}

				// sendBbPlayerLogs('refresh', 'refreshAd', slot);

				// Remove BB Player if rendered for current adUnit
				var bbPlayerId = getBbPlayerId(slot.containerId);
				removeBbPlayerIfRendered(bbPlayerId);
			}

			if (IS_NOT_PRODUCTION) {
				// -x-x-x-x-x for testing only x-x-x-x-x-
				var testingQueue = require('./testingQueue');

				testingQueue.executeQueue.call(this, 'resetVacantSlotStylesIfApplied', [ad.id]);
				// -x-x-x-x-x for testing only x-x-x-x-x-
			}
			adp.adpTags.queSlotForBidding(slot);

			setRefreshTimeOut(container, ad);
		}
	},
	removeBidderTargeting = function (slot) {
		if (slot.gSlot) {
			var targetingKeys = slot.gSlot.getTargetingKeys();
			for (var i = 0; i < targetingKeys.length; i++) {
				if (targetingKeys[i].match(/^hb_/g)) {
					slot.gSlot.clearTargeting(targetingKeys[i]);
				}
			}
		}
	},
	sendFeedback = function (ad) {
		var feedbackData = {
			ads: [],
			xpathMiss: [],
			errorCode: 1,
			mode: 1,
			referrer: adp.config.referrer,
			tracking: false
		};
		var feedbackMetaData = utils.getPageFeedbackMetaData();
		feedbackData = adp.$.extend({}, feedbackData, feedbackMetaData);
		feedbackData.ads = [ad];
		feedbackData.variationId = adp.config.selectedVariation;
		utils.sendFeedback(feedbackData);
	},
	stopRefreshForASlot = function (adId) {
		var adIndex = ads.findIndex((obj) => obj.ad.id === adId);

		if (adIndex !== -1) {
			var container = adp.$(`#${cssescape(adId)}`);
			var oldTimeoutId = container.attr('data-timeout');
			oldTimeoutId && clearTimeout(oldTimeoutId);

			ads.splice(adIndex, 1);
		}
	},
	getAllInViewAds = function () {
		inViewAds = [];
		for (var i = 0; i < ads.length; i++) {
			var container = adp.$(`#${cssescape(ads[i].ad.id)}`);
			if (container.length && utils.checkElementInViewPercent(container)) {
				inViewAds.push(ads[i]);
			}
		}
	},
	handleRefresh = function () {
		getAllInViewAds();

		for (var i = 0; i < inViewAds.length; i++) {
			var inViewAd = inViewAds[i],
				container = adp.$(`#${cssescape(inViewAd.ad.id)}`), // get updated container (inViewAd.container is not updated)
				ad = inViewAd.ad,
				adRenderTime = container.attr('data-render-time'),
				lastRefreshTime = container.attr('data-refresh-time'),
				currentTime = new Date().getTime(),
				adRefreshInterval =
					parseInt(ad.networkData.refreshInterval) * 1000 || commonConsts.AD_REFRESH_INTERVAL,
				timeDifferenceInSec,
				refreshInterval;
			if (lastRefreshTime) {
				// if Ad has been rendered before
				timeDifferenceInSec = currentTime - lastRefreshTime;
				if (timeDifferenceInSec > adRefreshInterval) {
					// if last refresh turn has been missed
					refreshInterval = 0;
					setRefreshTimeOut(container, ad, refreshInterval);
				}
				// else immediatly refresh it;
			} else {
				// If ad is rendering for the first time.
				timeDifferenceInSec = currentTime - adRenderTime;
				if (timeDifferenceInSec > adRefreshInterval) {
					// wait for 2 sec to count the impression of ad renedered first time.
					refreshInterval = 2000;
				} else {
					refreshInterval = adRefreshInterval;
				} // lazyloading case (if ad has just rendered, refreesh it after 30sec.)
				setRefreshTimeOut(container, ad, refreshInterval);
			}
		}
	},
	init = function () {
		/**
		 * In case our script is place inside iframe then scroll and focus event
		 * won't work properly and will cause issues in refresh. To fix this
		 * calling handleRefresh function initialy after 10s so that all processing
		 * should have been completed.
		 */
		setTimeout(handleRefresh, 10000);

		var w;
		try {
			var isIframe = window.self !== window.top;
			w = isIframe ? window.top : window;
		} catch (e) {
			/**
			 * 3rd party iframe will throw `DOMException` while accessing
			 * `window.top` due to same-origin policy. In that case use iframe window
			 */
			w = window;
		}

		adp.$(w).on('scroll', debounce(handleRefresh, 50));
		adp.$(w).on('focus', handleRefresh);
	},
	scheduleSlotRefresh = function (container, ad) {
		setRefreshTimeOut(container, ad);

		ads.push({
			container: container,
			ad: ad
		});
	};

module.exports = {
	init,
	scheduleSlotRefresh,
	stopRefreshForASlot,
	setRefreshTimeOutByAdId,
	getRefreshDataByAdId
};
