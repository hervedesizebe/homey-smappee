'use strict';

const Driver = require('../../lib/Driver');

class GeniusDriver extends Driver {

  /*
  | Pairing functions
  */

  // Return devices while pairing
  async getPairDevices({ oAuth2Client }) {
    return oAuth2Client.discoverGeniusDevices();
  }

  // Return capabilities while pairing
  getPairCapabilities(device) {
    const capabilities = ['measure_power'];

    if (device.solar) {
      capabilities.push('measure_power.production');
    }

    capabilities.push('measure_power.alwayson');
    capabilities.push('meter_power');
    capabilities.push('meter_power.imported');
    capabilities.push('meter_power.exported');

    return capabilities;
  }

  // Return device ID while pairing
  getPairDeviceId(device) {
    return `GE-${device.serviceLocationId}`;
  }

  // Return settings value while pairing
  getPairSettings(device) {
    return {
      serial_number: device.deviceSerialNumber,
    };
  }

  // Return store value while pairing
  getPairStore(device) {
    return {
      id: device.serviceLocationId,
      service_location_id: device.serviceLocationId,
      service_location_uuid: device.serviceLocationUuid,
    };
  }

}

module.exports = GeniusDriver;
