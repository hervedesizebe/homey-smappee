'use strict';

const MqttDevice = require('../../lib/MqttDevice');
const { blank, filled } = require('../../lib/Utils');
const ChargingState = require('../../models/ChargingState');

class EVWallDevice extends MqttDevice {

  static SYNC_INTERVAL = 660; // 11 minutes

  /*
  | Device events
  */

  // Charging mode capability changed
  async onCapabilityChargingMode(value) {
    this.log(`User changed capability 'charging_mode' to '${value}'`);

    await this.setChargingMode(value);
  }

  // Dim (LED brightness) changed
  async onCapabilityDim(value) {
    const percentage = value * 100;

    this.log(`User changed capability 'dim' to '${percentage}'`);

    await this.setBrightness(value);
  }

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
    // Charging state
    if (topic.endsWith('chargingstate')) {
      this.log('[ChargingState]', JSON.stringify(data));

      data = new ChargingState(data);

      await this.handleSyncData(data.capabilities);
    }

    // Power state (whole-home monitor message — carries the charger's CT channels)
    if (topic.endsWith('power')) {
      this.handleChargerPower(data);
    }

    // Updated message
    if (topic.endsWith('updated')) {
      this.log('[Updated]', JSON.stringify(data));

      data = this.getSyncDataFromUpdateMessage(data);

      await this.handleSyncData(data);
    }

    data = null;
  }

  // Settings changed
  async onSettings({ oldSettings, newSettings, changedKeys }) {
    this.log('[Settings] Updating');

    for (const name of changedKeys) {
      this.log(`[Settings] User changed '${name}' from '${oldSettings[name]}' to '${newSettings[name]}'`);
    }

    this.log('[Settings] Updated');
  }

  /*
  | Device actions
  */

  // LED brightness
  async setBrightness(percentage) {
    if (!this.hasCapability('dim')) {
      this.error('LED brightness not supported');
      throw new Error(this.homey.__('error.led'));
    }

    percentage *= 100;

    this.log(`Set LED brightness to '${percentage}%'`);

    await this.oAuth2Client.setLedBrightness(this.serviceLocationId, this.getStoreValue('led_id'), percentage);
  }

  // Activate charging mode
  async setChargingMode(mode) {
    const stationSerialNumber = this.getStore().station.serialNumber;
    const position = this.getStoreValue('position');

    this.log(`Set position '${position}' charging mode to '${mode}'`);

    await this.oAuth2Client.setChargingMode(stationSerialNumber, position, mode);

    this.setCapabilityValue('charging_mode', mode).catch(this.error);
  }

  /*
  | Synchronization functions
  */

  // Return data which need to be synced (charger power/energy come from MQTT, not here)
  async getSyncData() {
    const result = {};

    if (this.hasCapability('dim')) {
      result.led_brightness = await this.oAuth2Client.getLedBrightness(this.serviceLocationId, this.getStoreValue('led_id'));
    }

    return result;
  }

  // Set device data
  async handleSyncData(data) {
    if (blank(data)) return;

    this.log('[Sync]', JSON.stringify(data));

    // LED brightness (MQTT and sync)
    if (this.hasCapability('dim') && 'led_brightness' in data) {
      this.setCapabilityValue('dim', (data.led_brightness / 100)).catch(this.error);
    }

    // Cable connected (MQTT)
    if (this.hasCapability('cable_connected') && 'cableConnected' in data) {
      this.setCapabilityValue('cable_connected', data.cableConnected).catch(this.error);
    }

    // Charging (MQTT)
    if (this.hasCapability('charging') && 'charging' in data) {
      this.setCapabilityValue('charging', data.charging).catch(this.error);
    }

    // Charging mode (MQTT)
    if (this.hasCapability('charging_mode') && 'chargingMode' in data) {
      this.setCapabilityValue('charging_mode', data.chargingMode.toLowerCase()).catch(this.error);
    }

    // Standard EV charging state (derived from cable/charging/mode)
    if (this.hasCapability('evcharger_charging_state') && 'cableConnected' in data) {
      let state = 'plugged_out';

      if (data.cableConnected) {
        if (data.charging) state = 'plugged_in_charging';
        else if (data.chargingMode === 'paused') state = 'plugged_in_paused';
        else state = 'plugged_in';
      }

      this.setCapabilityValue('evcharger_charging_state', state).catch(this.error);
    }

    this.unsetWarning().catch(this.error);
  }

  // Derive the charger's own power/energy from the whole-home monitor's `channelData`.
  // The charger sits on a dedicated multi-phase CT: those channels read ~0 when idle and
  // jump when charging. We auto-learn them (the metering-configuration API is unavailable),
  // then sum them for `measure_power` and integrate over time for `meter_power`.
  handleChargerPower(data) {
    if (blank(data) || !Array.isArray(data.channelData)) return;

    const channels = data.channelData;
    const charging = this.getCapabilityValue('charging') === true;

    // Restore the idle snapshot from store after a restart
    if (!Array.isArray(this._idleChannels)) {
      this._idleChannels = this.getStoreValue('idle_channels');
    }

    if (!charging) {
      // Keep (and persist, throttled) the latest idle snapshot for channel detection
      this._idleChannels = channels;

      if (!this._idlePersistTs || (data.utcEndtime - this._idlePersistTs) > 60000) {
        this.setStoreValue('idle_channels', channels).catch(this.error);
        this._idlePersistTs = data.utcEndtime;
      }
    } else if (Array.isArray(this._idleChannels)) {
      // Union detection: a charger phase reads ~0 when idle and is significant while
      // charging. Charging ramps up gradually, so we keep merging phases as they appear.
      const stored = this.getStoreValue('charger_channels') || [];
      const set = new Set(stored);

      for (let i = 0; i < channels.length; i++) {
        if (channels[i] > 500 && (this._idleChannels[i] || 0) < 100) set.add(i);
      }

      if (set.size !== stored.length) {
        const merged = [...set].sort((a, b) => a - b);
        this.setStoreValue('charger_channels', merged).catch(this.error);
        this.log('[Charger] Power channels:', JSON.stringify(merged));
      }
    }

    // Charger power (W) — only while actively charging, so CT measurement noise and the
    // charger's standby draw don't show as a phantom flow when no car is connected
    const chargerChannels = this.getStoreValue('charger_channels');
    let power = 0;

    if (charging && Array.isArray(chargerChannels) && filled(chargerChannels)) {
      power = chargerChannels.reduce((sum, i) => sum + (channels[i] || 0), 0);
    }

    power = Math.max(0, Math.round(power));

    if (this.hasCapability('measure_power')) {
      this.setCapabilityValue('measure_power', power).catch(this.error);
    }

    // Accumulate charged energy (kWh) by integrating power over time
    if (this.hasCapability('meter_power.charged') && 'utcEndtime' in data) {
      if (this._lastPowerTs && data.utcEndtime > this._lastPowerTs) {
        const hours = (data.utcEndtime - this._lastPowerTs) / 3600000;
        const total = (this.getCapabilityValue('meter_power.charged') || 0) + ((power * hours) / 1000);

        this.setCapabilityValue('meter_power.charged', total).catch(this.error);
      }

      this._lastPowerTs = data.utcEndtime;
    }

    this.setAvailable().catch(this.error);
  }

  /*
  | MQTT functions
  */

  subscribeTopic() {
    return '#';
  }

  /*
  | Support functions
  */

  // Get synchronization data from update message
  getSyncDataFromUpdateMessage(data) {
    const updated = {};

    if ('configurationPropertyValues' in data) {
      for (const config of data.configurationPropertyValues) {
        if (!('propertySpecName' in config)) continue;
        if (blank(config.propertySpecName)) continue;

        // LED brightness
        if (config.propertySpecName.endsWith('brightness')) {
          updated.led_brightness = Number(config.value) || 0;
        }
      }
    }

    return updated;
  }

  // Migrate device properties
  async migrate() {
    this.log('[Migrate] Started');

    // One-time: ensure the device uses the `evcharger` class so Homey Energy treats it
    // as an EV charger (older pairings may have a different persisted class)
    if (!this.getStoreValue('class_migrated')) {
      if (this.getClass() !== 'evcharger') {
        await this.setClass('evcharger').catch(this.error);
        this.log('[Migrate] Set class to `evcharger`');
      }

      await this.setStoreValue('class_migrated', true).catch(this.error);
    }

    // Remove legacy `meter_power` (held whole-home consumption — wrong for the charger
    // and double-counted in Energy). Replaced by charger-only `meter_power.charged`.
    if (this.hasCapability('meter_power')) {
      await this.removeCapability('meter_power').catch(this.error);
      this.log('[Migrate] Removed legacy `meter_power` capability');
    }

    // Add `meter_power.charged` capability (charger energy, counted in Energy)
    if (!this.hasCapability('meter_power.charged')) {
      await this.addCapability('meter_power.charged').catch(this.error);
      this.log('[Migrate] Added `meter_power.charged` capability');
    }

    // Add `evcharger_charging_state` capability (standard EV charger state)
    if (!this.hasCapability('evcharger_charging_state')) {
      await this.addCapability('evcharger_charging_state').catch(this.error);
      this.log('[Migrate] Added `evcharger_charging_state` capability');
    }

    // Add `charging` capability
    if (!this.hasCapability('charging')) {
      await this.addCapability('charging').catch(this.error);
      this.log('[Migrate] Added `charging` capability');
    }

    // Add `dim` capability
    if (!this.hasCapability('dim') && filled(this.getStoreValue('led_id'))) {
      await this.addCapability('dim').catch(this.error);
      this.log('[Migrate] Added `dim` capability');
    }

    // Remove `measure_power.alwayson` capability
    if (this.hasCapability('measure_power.alwayson')) {
      await this.removeCapability('measure_power.alwayson').catch(this.error);
      this.log('[Migrate] Removed `measure_power.alwayson` capability');
    }

    this.log('[Migrate] Finished');
  }

}

module.exports = EVWallDevice;
