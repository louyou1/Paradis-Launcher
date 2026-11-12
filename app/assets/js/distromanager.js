const { DistributionAPI } = require('helios-core/common')

const ConfigManager = require('./configmanager')

// Old WesterosCraft url.
// exports.REMOTE_DISTRO_URL = 'http://mc.westeroscraft.com/WesterosCraftLauncher/distribution.json'
exports.REMOTE_DISTRO_URL = 'http://57.131.21.67:8090/distribution.json'

const api = new DistributionAPI(
    ConfigManager.getLauncherDirectory(),
    null, // Injected forcefully by the preloader.
    null, // Injected forcefully by the preloader.
    exports.REMOTE_DISTRO_URL,
    false
)

exports.DistroAPI = api

function getStaffAddonApiUrl(distribution){
    const configured = distribution?.rawDistribution?.staffAddon?.apiUrl
    const distroUrl = new URL(exports.REMOTE_DISTRO_URL)
    // Nebula does not currently emit custom staffAddon metadata, so default
    // to the staff API port on the same host. A distro field can override it.
    const apiUrl = configured
        ? new URL(configured, distroUrl)
        : new URL(`${distroUrl.protocol}//${distroUrl.hostname}:8091/v1`)
    if(apiUrl.hostname !== distroUrl.hostname) throw new Error('The staff API must use the distribution host.')
    return apiUrl.toString().replace(/\/$/, '')
}

api.getStaffAddonApiUrl = getStaffAddonApiUrl
exports.getStaffAddonApiUrl = getStaffAddonApiUrl
