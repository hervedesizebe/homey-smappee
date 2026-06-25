'use strict';

const { OAuth2Device } = require('homey-oauth2app');

class Device extends OAuth2Device {

  /*
  | Device events
  */

  // Device added
  async onOAuth2Added() {
    this.log('Added');
  }

  // Device deleted
  async onOAuth2Deleted() {
    this.log('Deleted');
  }

  // Device initialized
  async onOAuth2Init() {
    // Connecting to API
    await this.setUnavailable(this.homey.__('authentication.connecting'));

    // Set default data
    this.setDefaults();

    // Register capability listeners
    this.registerCapabilityListeners();

    // Synchronize device
    await this.sync();

    this.log('Initialized');
  }

  // Device destroyed
  async onOAuth2Uninit() {
    // Unregister timer
    this.unregisterTimer();

    this.log('Destroyed');
  }

  // Timer action
  async onTimerInterval() {
    await this.sync();
  }

  /*
  | Synchronization functions
  */

  // Synchronize
  async sync() {
    let result;

    try {
      this.log('[Sync] Get last measures from API');

      result = await this.getSyncData();

      await this.handleSyncData(result);

      // Set (and persist) latest record timestamp so restarts resume incrementally
      if (result.timestamp) {
        this.latestRecordTime = result.timestamp;
        this.setStoreValue('latest_record_time', result.timestamp).catch(this.error);
      }
    } catch (err) {
      this.error('[Sync]', err.message);
      this.setUnavailable(err.message).catch(this.error);
    } finally {
      result = null;
    }
  }

  // Return data which need to be synced
  async getSyncData() {
    return {};
  }

  // Set device data
  async handleSyncData(data) {
    //
  }

  /*
  | Listener functions
  */

  // Register capability listeners
  registerCapabilityListeners() {
    if (this.hasCapability('button.reset_water_meter')) {
      this.registerCapabilityListener('button.reset_water_meter', this.onCapabilityResetWaterMeter.bind(this));
    }

    if (this.hasCapability('charging_mode')) {
      this.registerCapabilityListener('charging_mode', this.onCapabilityChargingMode.bind(this));
    }

    if (this.hasCapability('dim')) {
      this.registerCapabilityListener('dim', this.onCapabilityDim.bind(this));
    }

    if (this.hasCapability('onoff')) {
      this.registerCapabilityListener('onoff', this.onCapabilityOnOff.bind(this));
    }

    this.log('Capability listeners registered');
  }

  /*
  | Timer functions
  */

  // Register timer
  registerTimer() {
    if (this.syncDeviceTimer) return;

    const interval = 1000 * this.constructor.SYNC_INTERVAL;

    this.syncDeviceTimer = this.homey.setInterval(this.onTimerInterval.bind(this), interval);

    this.log('[Timer] Registered');
  }

  // Unregister timer
  unregisterTimer() {
    if (!this.syncDeviceTimer) return;

    this.homey.clearTimeout(this.syncDeviceTimer);

    this.syncDeviceTimer = null;

    this.log('[Timer] Unregistered');
  }

  /*
  | Support functions
  */

  // Set default data
  setDefaults() {
    // Resume from the last synced timestamp so a restart continues with incremental
    // deltas instead of re-anchoring the cumulative meters to a freshly recomputed
    // lifetime total (which can jump and inflate the Energy graph).
    this.latestRecordTime = this.getStoreValue('latest_record_time') || null;

    this.serviceLocationId = this.getStoreValue('service_location_id');
    this.serviceLocationUuid = this.getStoreValue('service_location_uuid');
  }

}

module.exports = Device;
