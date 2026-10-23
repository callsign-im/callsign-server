import pkg from "../package.json" with { type: "json" };

export const VERSION = pkg.version;
export const SERVER_NAME = "im.callsign/callsign";
