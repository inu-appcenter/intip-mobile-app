/**
 * Allows the legacy INU ERP SSO hand-off only. The portal authenticates over
 * HTTPS, then passes through HTTP-only endpoints on the portal and ERP before
 * reaching the HTTPS ERP application; Android 9+ (cleartext policy) and iOS
 * (ATS) both block that hop otherwise.
 */
const {
  withAndroidManifest,
  withDangerousMod,
  withInfoPlist,
} = require("expo/config-plugins");
const fs = require("fs");
const path = require("path");

const NETWORK_SECURITY_CONFIG = `<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
    <domain-config cleartextTrafficPermitted="true">
        <domain includeSubdomains="true">portal.inu.ac.kr</domain>
        <domain includeSubdomains="true">erp.inu.ac.kr</domain>
        <domain includeSubdomains="true">localhost</domain>
        <domain includeSubdomains="true">127.0.0.1</domain>
        <domain includeSubdomains="true">10.0.2.2</domain>
    </domain-config>
</network-security-config>
`;

/**
 * Hosts the SSO hand-off passes through over plain HTTP. iOS blocks those with
 * ATS (`NSURLErrorDomain -1022`, "requires the use of a secure connection"),
 * which strands the hidden scraper WebView on the ERP hop until it times out.
 */
const CLEARTEXT_HOSTS = ["portal.inu.ac.kr", "erp.inu.ac.kr"];

module.exports = function withErpSsoCleartext(config) {
  config = withInfoPlist(config, (cfg) => {
    const ats = cfg.modResults.NSAppTransportSecurity || {};
    const exceptions = ats.NSExceptionDomains || {};

    for (const host of CLEARTEXT_HOSTS) {
      exceptions[host] = {
        ...exceptions[host],
        NSExceptionAllowsInsecureHTTPLoads: true,
        NSIncludesSubdomains: true,
      };
    }

    ats.NSExceptionDomains = exceptions;
    cfg.modResults.NSAppTransportSecurity = ats;
    return cfg;
  });

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
