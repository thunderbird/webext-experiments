"use strict";

module.exports = {
  "env": {
    "es2022": true,
    "webextensions": true
  },
  "root": true,
  "plugins": ["mozilla"],
  "extends": ["plugin:mozilla/recommended"], 

   overrides: [
    {
      files: [".eslintrc.js"],
      env: {
        node: true,
        browser: false,
      },
    },
  ]
};
