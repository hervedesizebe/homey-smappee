'use strict';

const MqttDevice = require('../../lib/MqttDevice');
const { blank } = require('../../lib/Utils');

class GeniusDevice extends MqttDevice {

  static SYNC_INTERVAL = 840; // 14 minutes

  /*
  | Device events
  */

  // Device initialized
  async onOAuth2Init() {
    // Migrate
    await this.migrate();

    // Register timer
    this.registerTimer();

    // Initialize parent
    await super.onOAuth2Init();
  }

  // MQTT message received
  async onMessage(topic, data) {
    await this.handleSyncData(data);
  }

  /*
  | Synchronization functions
  */

  // Return data which need to be synced
  async getSyncData() {
    return this.latestRecordTime
      ? this.oAuth2Client.getLatestServiceLocationConsumption(this.serviceLocationId, this.latestRecordTime)
      : this.oAuth2Client.getInitialServiceLocationConsumption(this.serviceLocationId);
  }

  // Set device data
  async handleSyncData(data) {
    if (blank(data)) return;

    this.log('[Sync]', JSON.stringify(data));

    // Net grid power (MQTT): positive = imported from grid, negative = exported.
    // The Connect is the grid meter, so measure_power must be the NET grid flow for
    // Homey's Energy flow direction to be correct (solar offsets consumption).
    if (this.hasCapability('measure_power') && 'consumptionPower' in data) {
      const solarPower = 'solarPower' in data ? data.solarPower : 0;

      this.setCapabilityValue('measure_power', data.consumptionPower - solarPower).catch(this.error);
    }

    // Solar power (MQTT)
    if (this.hasCapability('measure_power.production') && 'solarPower' in data) {
      this.setCapabilityValue('measure_power.production', data.solarPower).catch(this.error);
    }

    // Always on (MQTT)
    if (this.hasCapability('measure_power.alwayson') && 'alwaysOn' in data) {
      this.setCapabilityValue('measure_power.alwayson', data.alwaysOn).catch(this.error);
    }

    // Total consumption energy (sync) — required for Homey's "Home" consumption figure
    if (this.hasCapability('meter_power') && 'consumption' in data) {
      let current = this.latestRecordTime ? (this.getCapabilityValue('meter_power') || 0) : 0;
      current += data.consumption;

      this.setCapabilityValue('meter_power', current).catch(this.error);
    }

    // Imported energy (sync)
    if (this.hasCapability('meter_power.imported') && 'gridImport' in data) {
      let current = this.latestRecordTime ? (this.getCapabilityValue('meter_power.imported') || 0) : 0;
      current += data.gridImport;

      this.setCapabilityValue('meter_power.imported', current).catch(this.error);
    }

    // Exported energy (sync)
    if (this.hasCapability('meter_power.exported') && 'gridExport' in data) {
      let current = this.latestRecordTime ? (this.getCapabilityValue('meter_power.exported') || 0) : 0;
      current += data.gridExport;

      this.setCapabilityValue('meter_power.exported', current).catch(this.error);
    }

    this.unsetWarning().catch(this.error);
    this.setAvailable().catch(this.error);
  }

  /*
  | MQTT functions
  */

  subscribeTopic() {
    return 'power';
  }

  /*
  | Support functions
  */

  // Migrate device properties
  async migrate() {
    this.log('[Migrate] Started');

    // One-time: restore the `sensor` class (some devices were manually set to
    // `solarpanel`, which makes Homey Energy read consumption as production)
    if (!this.getStoreValue('class_migrated')) {
      if (this.getClass() !== 'sensor') {
        await this.setClass('sensor').catch(this.error);
        this.log(`[Migrate] Reset class from \`${this.getClass()}\` to \`sensor\``);
      }

      await this.setStoreValue('class_migrated', true).catch(this.error);
    }

    // Ensure total-consumption `meter_power` exists (drives Homey's "Home" consumption)
    if (!this.hasCapability('meter_power')) {
      await this.addCapability('meter_power').catch(this.error);
      this.log('[Migrate] Added `meter_power` capability');
    }

    // Add `meter_power.imported` capability
    if (!this.hasCapability('meter_power.imported')) {
      await this.addCapability('meter_power.imported').catch(this.error);
      this.log('[Migrate] Added `meter_power.imported` capability');
    }

    // Add `meter_power.exported` capability
    if (!this.hasCapability('meter_power.exported')) {
      await this.addCapability('meter_power.exported').catch(this.error);
      this.log('[Migrate] Added `meter_power.exported` capability');
    }

    this.log('[Migrate] Finished');
  }

}

module.exports = GeniusDevice;
