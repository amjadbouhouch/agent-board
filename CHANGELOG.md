# Changelog

All notable changes to this project will be documented in this file. See [commit-and-tag-version](https://github.com/absolute-version/commit-and-tag-version) for commit guidelines.

## [0.3.1](https://github.com/amjadbouhouch/agent-board/compare/v0.3.0...v0.3.1) (2026-09-03)

### Bug Fixes

* **cli:** list upsert and --on-conflict in help ([11b27d0](https://github.com/amjadbouhouch/agent-board/commit/11b27d05edd4b2931d08eee000e873337e2a4f0b))
## [0.3.0](https://github.com/amjadbouhouch/agent-board/compare/v0.2.1...v0.3.0) (2026-09-03)

### ⚠ BREAKING CHANGES

* **dsl:** a `filter` component must now declare `targets`. A filter that
  drives nothing renders a control the user can change to no effect, which is the
  class of failure this validator exists to make impossible.

### Features

* **dsl:** filter results, bind filter controls, serve a UI, and upsert rows ([9f580f7](https://github.com/amjadbouhouch/agent-board/commit/9f580f74d09bf87d2a73e3b2e6996120c2dc26b8))
## [0.2.1](https://github.com/amjadbouhouch/agent-board/compare/v0.2.0...v0.2.1) (2026-09-03)

### Features

* **query:** let a component ask for the rows it needs ([fbf239e](https://github.com/amjadbouhouch/agent-board/commit/fbf239e79cea4cdd611d551c020c94691a6b1787))
## [0.2.0](https://github.com/amjadbouhouch/agent-board/compare/v0.1.1...v0.2.0) (2026-09-03)

### Features

* **rows:** manipulate data through the CLI rather than through migrations ([ec0315b](https://github.com/amjadbouhouch/agent-board/commit/ec0315b080af8efce0b1ba4d4657669a7bd71ca3))

### Bug Fixes

* **query:** report a driver failure as a message, not a stack trace ([e262df3](https://github.com/amjadbouhouch/agent-board/commit/e262df3f75b22d1f1b74482bc73df7f0eaebf2d6))

### Documentation

* record the schema/data split and what a column name does not mean ([62142fd](https://github.com/amjadbouhouch/agent-board/commit/62142fd74bed3e45c8d2ae2aba858048d673b12d))
## [0.1.1](https://github.com/amjadbouhouch/agent-board/compare/v0.1.0...v0.1.1) (2026-09-02)

### Features

* **install:** offer to add the install dir to PATH ([684f899](https://github.com/amjadbouhouch/agent-board/commit/684f899d6d275fe01b7bccdf11c7d663e0e27153))

### Bug Fixes

* **dsl:** validate the whole component contract, not just its type ([fd311f8](https://github.com/amjadbouhouch/agent-board/commit/fd311f8114fb4e6b7e8c9709af783e158ef1c45e))
* **publish:** make an application version commit atomically ([faa62b0](https://github.com/amjadbouhouch/agent-board/commit/faa62b058ecb98f3f9d34f88c0cd1be9b105a325))
* **server:** bound request input before it reaches the query engine ([7e8156d](https://github.com/amjadbouhouch/agent-board/commit/7e8156d0012af344ebbf7ac003abecc5a81f1e91))
## 0.1.0 (2026-09-02)

### Features

* agent-created data application runtime ([4b7b24d](https://github.com/amjadbouhouch/agent-board/commit/4b7b24df5509198924980fe986b63a35a2cde006))
