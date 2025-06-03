# Obsidian Sample Plugin

[](https://github.com/obsidianmd/obsidian-sample-plugin#obsidian-sample-plugin)

This is a sample plugin for Obsidian ([https://obsidian.md](https://obsidian.md)).

This project uses TypeScript to provide type checking and
documentation.
The repo depends on the latest plugin API (obsidian.d.ts) in TypeScript
Definition format, which contains TSDoc comments describing what it
does.

This sample plugin demonstrates some of the basic functionality the plugin API can do.

* Adds a ribbon icon, which shows a Notice when clicked.
* Adds a command "Open Sample Modal" which opens a Modal.
* Adds a plugin setting tab to the settings page.
* Registers a global click event and output 'click' to the console.
* Registers a global interval which logs 'setInterval' to the console.

## First time developing plugins?

[](https://github.com/obsidianmd/obsidian-sample-plugin#first-time-developing-plugins)

Quick starting guide for new plugin devs:

* Check if [someone already developed a plugin for what you want](https://obsidian.md/plugins)! There might be an existing plugin similar enough that you can partner up with.
* Make a copy of this repo as a template with the "Use this template" button (login to GitHub if you don't see it).
* Clone your repo to a local development folder. For convenience, you can place this folder in your `.obsidian/plugins/your-plugin-name` folder.
* Install NodeJS, then run `npm i` in the command line under your repo folder.
* Run `npm run dev` to compile your plugin from `main.ts` to `main.js`.
* Make changes to `main.ts` (or create new `.ts` files). Those changes should be automatically compiled into `main.js`.
* Reload Obsidian to load the new version of your plugin.
* Enable plugin in settings window.
* For updates to the Obsidian API run `npm update` in the command line under your repo folder.

## Releasing new releases

[](https://github.com/obsidianmd/obsidian-sample-plugin#releasing-new-releases)

* Update your `manifest.json` with your new version number, such as `1.0.1`, and the minimum Obsidian version required for your latest release.
* Update your `versions.json` file with `"new-plugin-version": "minimum-obsidian-version"` so older versions of Obsidian can download an older version of your plugin that's compatible.
* Create new GitHub release using your new version number as the "Tag
  version". Use the exact version number, don't include a prefix `v`. See here for an example: [https://github.com/obsidianmd/obsidian-sample-plugin/releases](https://github.com/obsidianmd/obsidian-sample-plugin/releases)
* Upload the files `manifest.json`, `main.js`, `styles.css`
  as binary attachments. Note: The manifest.json file must be in two
  places, first the root path of your repository and also in the release.
* Publish the release.

> You can simplify the version bump process by running `npm version patch`, `npm version minor` or `npm version major` after updating `minAppVersion` manually in `manifest.json`.
> The command will bump version in `manifest.json` and `package.json`, and add the entry for the new version to `versions.json`

## Adding your plugin to the community plugin list

[](https://github.com/obsidianmd/obsidian-sample-plugin#adding-your-plugin-to-the-community-plugin-list)

* Check the [plugin guidelines](https://docs.obsidian.md/Plugins/Releasing/Plugin+guidelines).
* Publish an initial version.
* Make sure you have a `README.md` file in the root of your repo.
* Make a pull request at [https://github.com/obsidianmd/obsidian-releases](https://github.com/obsidianmd/obsidian-releases) to add your plugin.

## How to use

[](https://github.com/obsidianmd/obsidian-sample-plugin#how-to-use)

* Clone this repo.
* Make sure your NodeJS is at least v16 (`node --version`).
* `npm i` or `yarn` to install dependencies.
* `npm run dev` to start compilation in watch mode.

## Manually installing the plugin

[](https://github.com/obsidianmd/obsidian-sample-plugin#manually-installing-the-plugin)

* Copy over `main.js`, `styles.css`, `manifest.json` to your vault `VaultFolder/.obsidian/plugins/your-plugin-id/`.

## Improve code quality with eslint (optional)

[](https://github.com/obsidianmd/obsidian-sample-plugin#improve-code-quality-with-eslint-optional)

* [ESLint](https://eslint.org/) is a tool
  that analyzes your code to quickly find problems. You can run ESLint
  against your plugin to find common bugs and ways to improve your code.
* To use eslint with this project, make sure to install eslint from terminal:
  * `npm install -g eslint`
* To use eslint to analyze this project use this command:
  * `eslint main.ts`
  * eslint will then create a report with suggestions for code improvement by file and line number.
* If your source code is in a folder, such as `src`, you can use eslint with this command to analyze all files in that folder:
  * `eslint .\src\`

## Funding URL

[](https://github.com/obsidianmd/obsidian-sample-plugin#funding-url)

You can include funding URLs where people who use your plugin can financially support it.

The simple way is to set the `fundingUrl` field to your link in your `manifest.json` file:

```json
{
    "fundingUrl": "https://buymeacoffee.com"
}
  
```

If you have multiple URLs, you can also do:

```json
{
    "fundingUrl": {
        "Buy Me a Coffee": "https://buymeacoffee.com",
        "GitHub Sponsor": "https://github.com/sponsors",
        "Patreon": "https://www.patreon.com/"
    }
}
  
```


## Obsidian API

[](https://github.com/obsidianmd/obsidian-api#obsidian-api)

Type definitions for the latest [Obsidian](https://obsidian.md) API.

### Documentation

[](https://github.com/obsidianmd/obsidian-api#documentation)

You can browse our Plugin API documentation at [https://docs.obsidian.md/](https://docs.obsidian.md/)

For an example on how to create Obsidian plugins, use the template at [https://github.com/obsidianmd/obsidian-sample-plugin](https://github.com/obsidianmd/obsidian-sample-plugin)

### Issues and API requests

[](https://github.com/obsidianmd/obsidian-api#issues-and-api-requests)

For issues with the API, or to make requests for new APIs, please go to our forum: [https://forum.obsidian.md/c/developers-api/14](https://forum.obsidian.md/c/developers-api/14)

### Plugin structure

[](https://github.com/obsidianmd/obsidian-api#plugin-structure)

`manifest.json`

* `id` the ID of your plugin.
* `name` the display name of your plugin.
* `author` the plugin author's name.
* `version` the version of your plugin.
* `minAppVersion` the minimum required Obsidian version for your plugin.
* `description` the long description of your plugin.
* `isDesktopOnly` whether your plugin uses NodeJS or Electron APIs.
* `authorUrl` (optional) a URL to your own website.
* `fundingUrl` (optional) a link for users to donation to show appreciation and support plugin development.

`main.js`

* This is the main entry point of your plugin.
* Import any Obsidian API using `require('obsidian')`
* Import NodeJS or Electron API using `require('fs')` or `require('electron')`
* Must export a default class which extends `Plugin`
* Must bundle all external dependencies into this file, using Rollup, Webpack, or another javascript bundler.

### App Architecture

[](https://github.com/obsidianmd/obsidian-api#app-architecture)

##### The app is organized into a few major modules:

[](https://github.com/obsidianmd/obsidian-api#the-app-is-organized-into-a-few-major-modules)

* `App`, the global object that owns everything else. You can access this via `this.app` inside your plugin. The `App` interface provides accessors for the following interfaces.
* `Vault`, the interface that lets you interact with files and folders in the vault.
* `Workspace`, the interface that lets you interact with panes on the screen.
* `MetadataCache`, the interface that contains cached metadata about each markdown file, including headings, links, embeds, tags, and blocks.

##### Additionally, by inheriting `Plugin`, you can:

[](https://github.com/obsidianmd/obsidian-api#additionally-by-inheriting-plugin-you-can)

* Add a ribbon icon using `this.addRibbonIcon`.
* Add a status bar (bottom) element using `this.addStatusBarItem`.
* Add a global command, optionally with a default hotkey, using `this.addCommand`.
* Add a plugin settings tab using `this.addSettingTab`.
* Register a new kind of view using `this.registerView`.
* Save and load plugin data using `this.loadData` and `this.saveData`.

##### Registering events

[](https://github.com/obsidianmd/obsidian-api#registering-events)

For registering events from any event interfaces, such as `App` and `Workspace`, please use `this.registerEvent`, which will automatically detach your event handler when your plugin unloads:

```
this.registerEvent(app.on('event-name', callback));
```

If you register DOM events for elements that persist on the page after your plugin unloads, such as `window` or `document` events, please use `this.registerDomEvent`:

```
this.registerDomEvent(element, 'click', callback);
```

If you use `setInterval`, please use `this.registerInterval`:

```
this.registerInterval(setInterval(callback, 1000));
```
