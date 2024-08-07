"use strict";

module.exports = {
  "env": {
    "es2022": true,
    "webextensions": true
  },
  "root": true,
  "plugins": ["mozilla"],
  "extends": ["plugin:mozilla/recommended"], 

  rules: {
    // experiment files are not ES modules, so we can't use static import
    "mozilla/use-static-import": "off",

    // We are still experimenting, console messages are ok for now
    "no-console": "off"
  },

   overrides: [
    {
      files: [".eslintrc.js"],
      env: {
        node: true,
        browser: false,
      },
    },
    {
      files: ["*/experiments/*/parent/*.js"],
      globals: {
        global: true,
        Services: true,
      }
    }
  ]
};
