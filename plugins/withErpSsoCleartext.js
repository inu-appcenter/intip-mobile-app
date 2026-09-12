/**
 * Allows the legacy INU ERP SSO hand-off only. The portal authenticates over
 * HTTPS, then redirects to http://erp.inu.ac.kr:8881 before reaching the HTTPS
 * ERP application; Android 9+ otherwise blocks that single redirect.
 */
const { withAndroidManifest, withDangerousMod } = require("expo/config-plugins");
const fs = require("fs");
const path = require("path");

const NETWORK_SECURITY_CONFIG = `<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
    <domain-config cleartextTrafficPermitted="true">
        <domain includeSubdomains="true">erp.inu.ac.kr</domain>
    </domain-config>
</network-security-config>
`;

module.exports = function withErpSsoCleartext(config) {
  config = withAndroidManifest(config, (cfg) => {
    const application = cfg.modResults.manifest.application?.[0];
    if (!application) throw new Error("Android application manifest를 찾을 수 없습니다.");
    application.$["android:networkSecurityConfig"] = "@xml/network_security_config";
    return cfg;
  });

  return withDangerousMod(config, ["android", async (cfg) => {
    const xmlDirectory = path.join(cfg.modRequest.platformProjectRoot, "app", "src", "main", "res", "xml");
    fs.mkdirSync(xmlDirectory, { recursive: true });
    fs.writeFileSync(path.join(xmlDirectory, "network_security_config.xml"), NETWORK_SECURITY_CONFIG);
    return cfg;
  }]);
};
