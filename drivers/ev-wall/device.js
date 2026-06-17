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
  // The charger sits on a dedicated multi-phase CT, so its channels read ~0 whenever the
  // car is NOT charging and jump when it is. We learn them by tracking, per channel, the
  // max power ever seen while idle (`idle_max`): a charger channel is one that stays ~0 at
  // idle AND is significant while charging. This excludes grid/house channels (which draw
  // power during the day) and self-heals if one was previously mis-detected.
  static IDLE_MAX_W = 120; // a charger CT channel never exceeds this while not charging
  static CHARGE_MIN_W = 1000; // a charging phase clearly exceeds this

  handleChargerPower(data) {
    if (blank(data) || !Array.isArray(data.channelData)) return;

    const channels = data.channelData;
    const charging = this.getCapabilityValue('charging') === true;
    const idleMax = this.getStoreValue('idle_max') || [];

    if (!charging) {
      // Track the running max absolute power per channel while idle (persist, throttled)
      let changed = false;

      for (let i = 0; i < channels.length; i++) {
        const abs = Math.abs(channels[i] || 0);
        if (abs > (idleMax[i] || 0)) {
          idleMax[i] = abs;
          changed = true;
        }
      }

      if (changed && (!this._idleMaxTs || (data.utcEndtime - this._idleMaxTs) > 60000)) {
        this.setStoreValue('idle_max', idleMax).catch(this.error);
        this._idleMaxTs = data.utcEndtime;
      }
    } else {
      // While charging, (re)derive the charger channels: significant now AND consistently
      // ~0 at idle. Re-evaluating every message both catches ramp-up and drops any channel
      // later found to carry idle load (self-cleaning against earlier mis-detection).
      const stored = this.getStoreValue('charger_channels') || [];
      const set = new Set(stored.filter((i) => (idleMax[i] || 0) < this.constructor.IDLE_MAX_W));

      for (let i = 0; i < channels.length; i++) {
        if (channels[i] > this.constructor.CHARGE_MIN_W && (idleMax[i] || 0) < this.constructor.IDLE_MAX_W) {
          set.add(i);
        }
      }

      const detected = [...set].sort((a, b) => a - b);

      if (JSON.stringify(detected) !== JSON.stringify(stored)) {
        this.setStoreValue('charger_channels', detected).catch(this.error);
        this.log('[Charger] Power channels:', JSON.stringify(detected));
      }
    }

    // Charger power (W) — only while actively charging, so CT measurement noise and the
    // charger's standby draw don't show as a phantom flow when no car is connected
    const chargerChannels = this.getStoreValue('charger_channels');
    let power = 0;

    if (charging && Array.isArray(chargerChannels) && filled(chargerChannels)) {
      power = chargerChannels.reduce((sum, i) => sum + Math.max(0, channels[i] || 0), 0);
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

    // One-time: the previous union-based channel detection could merge grid phases into
    // the charger channels (overcounting the charged energy). Clear it and reset the
    // inflated meter so the new idle-max-gated detection can re-learn cleanly.
    if (!this.getStoreValue('charger_channels_reset')) {
      await this.unsetStoreValue('charger_channels').catch(this.error);
      await this.unsetStoreValue('idle_channels').catch(this.error);
      await this.unsetStoreValue('idle_max').catch(this.error);

      if (this.hasCapability('meter_power.charged')) {
        await this.setCapabilityValue('meter_power.charged', 0).catch(this.error);
      }

      await this.setStoreValue('charger_channels_reset', true).catch(this.error);
      this.log('[Migrate] Reset charger channel detection + charged meter');
    }

    this.log('[Migrate] Finished');
  }

}

module.exports = EVWallDevice;
