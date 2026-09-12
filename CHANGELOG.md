# Changelog
All notable changes to Volla Messages will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

## [1.0.3] - 2026-09-12

- Fix: The app could hang forever on the "Starting up..." screen, most often on faster machines. Holochain had actually started correctly; the app just never noticed and kept waiting.
- Feat: Your conversations, contacts and profile are now saved in a form that can be carried into the next major update, so you will not have to start over. This happens automatically in the background.
- Fix: Integration tests now run one file at a time, which stops them timing out spuriously in CI.

## [1.0.2] - 2026-08-25

- Fix: The unread indicator now appears inline with the message preview in the conversation list, instead of on its own line above it.
- Feat: macOS builds are now provided for Intel Macs in addition to Apple Silicon.

## [1.0.1] - 2026-08-03

- Fix: Scroll functionality has been optimized.

## [1.0.0] - 2026-07-27

- Feat: Added message delivery status indicators (single tick for sent, double tick for delivered).
- Fix: Added automatic reconnection recovery after the app has been backgrounded for a long time, instead of the connection hanging indefinitely.
- Fix: Updated the servers used for peer discovery and connectivity, improving connection reliability.
- Fix: Fixed chat history pagination — eliminated redundant loads and improved scroll-position stability when loading older messages.
- Feat: Rebuilt the message list for smoother, faster scrolling in large conversations.
- Fix: Fixed laggy/janky scrolling in conversations.
- Fix: Fixed a crash on launch for existing installs after a local message-cache database schema change.
- Fix: Conversation list previews now correctly show a second line of message content instead of being cut short.
- Feat: Added support for line breaks when composing a message.
- Feat: Added a "[Name] joined the conversation" notice shown to other members when someone joins a public conversation.
- Fix: Fixed long messages overflowing their message bubble instead of wrapping properly.
- Fix: Fixed conversation list previews showing the wrong summary (incorrect image/file attachment counts).
- Fix: Fixed incorrect or missing display name and avatar shown in private conversations.
- Fix: Fixed links in messages not opening.
- Feat: Added a built-in QR code scanner for joining conversations.
- Fix: Fixed a broken settings page layout.
- Feat: Changed the app icon to a dedicated Volla Messages icon.
- Fix: Removed a spurious error message shown on app startup.
- Fix: Fixed an image-loading bug in message attachments.
- Feat: Added Linux ARM64 builds (Raspberry Pi, Snapdragon/MediaTek ARM laptops, Apple Silicon).
- Feat: Added Hindi translation.
- Feat: Improved and expanded German translation.
- Fix: Updated Spanish and Italian translations

## [0.8.2] - 2025-05-31

- Fix building for 'lite' and 'rich' variants with different android package names.

## [0.8.1] - 2025-05-31

- Added npm command to run app locally using production `.happ`.
- CI release builds with the feature `holochain_service` now have a different android package name `org.volla.messages.service`. CI release builds with the feature `holochain_bundled` now have a different app name of "Volla Messages (Standalone)".
- Upgrade to latest `tauri-plugin-holochain-service-client` on Holochain 0.5.

## [0.8.0] - 2025-05-20

- **BREAKING CHANGE** Upgrade to Holochain 0.5

## [0.7.6] - 2025-03-21

- Fix: Display "unconfirmed" label for contacts that have not yet joined their private conversation.
- Fix: In public converastion invitations, use the cell name as the conversation title when convesation config is not available.
- Fix: Open external links in message content in system default browser or mail client.
- Feat: Delete a contact by clicking the "Delete Contact" button on their page.
- Feat: Added 2 features: Feature `holochain_bundled` bundles a holochain conductor with the app (the previous behavior). Feature `holochain_service` relies on a holochain conductor provided by the Android Service Runtime app.
- Feat: CI builds a "rich" and "lite" version of the android app, where the "rich" version uses feature `holochain_bundled`, and the "lite" version uses feature `holochain_service`.
- Fix: Use uuid network seed for provisioned cell, instead of system timestamp.
- Fix: Ensure all npm scripts running the app in dev mode enable one of the required features `holochain_bundled`, and `holochain_service`.
- Feat: CI now builds `.aab` files needed for Google Play Store release, generating two variants (`rich` and `lite`) analogous to APK builds.
- Feat: Virtual Scrolling of messages in conversations page, to ensure smooth scrolling of a large collection of already-loaded messages.
- Fix: Avoid rendering too many messages at once within a conversation, which could cause the app to crash.
- Fix: Remove bottom loading spinner from message list when scrolling, and implement concurrent message loading.
- Fix: Empty conversations with multiple peers display first message properly, without needing to reload after message is sent.
- Feat: Users can delete the message they had sent by clicking "Delete".

## [0.7.5] - 2025-01-10

- Fix: Major refactoring of the frontend data stores for clarity, readability, maintainability, reducing bugs related to frontend state, following svelte conventions.
- Fix: Major refactoring of the frontend components for clarity, readability, maintainability, removing duplicate code, avoiding overly complex implementations, ensuring consistent styling, fixing styling inconsistencies.
- Fix: Refactoring of frontend types for consistency with the backend types, removing redundancy, clearer and consistent naming. Add types for function inputs and outputs
- Fix: Modify app loading message to clarify when we are connecting to holochain versus initializing frontend stores.
- Fix: One of the duplicate implementations of share code button didn't fire
- Fix: Links in messages are now rendered as links even when missing the protocol prefix. Numbers with dots do not get rendered as links.
- Chore: Cleanup of translations files, each locale has a single file, strings are ordered by key alphabetically, redundant and unused strings have been removed.
- Chore: formatting of codebase
- Feat: Minor improvements to styling in light and dark modes
- Feat: Display loading indicator on Conversation page while fetching messages
- Feat: Archiving conversations now disables the cell, unarchiving them re-enables the cell.
- Feat: Messages can now include any file as an attachment, not just images
- Feat: email addresses in messages are rendered as mailto: links

## [0.7.4] - 2024-12-12

- Feat: display success & error notices throughout the app when no other UI feedback is provided
- Feat: download images from messages
- Fix: disable change name submit button when first name is not valid length

## [0.7.3] - 2024-11-23
- Fix: Blank screen on Ubuntu 22.04 was not actually fixed in 0.7.1. Now it is fixed.

## [0.7.2] - 2024-11-22
- Fix: macOS x64 builds no longer crash on launch
- Fix: Windows releases are now code signed

## [0.7.1] - 2024-11-12

### Added
- Automated release builds in CI
- Windows bundle code signing, macOS bundle code signing and notarization in CI
- Added a github env var IGNORE_WINDOWS_CODESIGNING_ERROR. When set to "true", errors with windows code signing will not be fatal to the build job.
- All releases except the Android app use a different icon with the Volla logo.
- Fix: Blank screen on Ubuntu 22.04

## [0.7.0-beta] - 2024-10-23

### Fixed
- Increase initial zome call timeout to avoid hanging on loading page
- Improve image loading resiliance by increasing retry rate exponential backoff to 2x
- Ensure image loading placeholder's error icon has contrasting color
- Fix: Prevent long group names from overflowing layout

### Added
- display error notice if conductor setup fails
- Update translations to use Volla Messages

## [0.7.0-beta-rc.0] - 2024-10-04

- Update name and icons, and splash screen

## [0.6.1-beta] - 2024-09-06

### Changed
- Don't include images in group invitation codes because it makes them too long
- Remove the hover toolips and click to copy on idneticons for users that don't have profile images
- Show in inbox conversation summary how many images were attached to the latest message

## [0.6.0-beta] - 2024-09-04

### Added
- New confirmation flow when creating a contact. Immediately add a 1:1 conversation with the new contact and go straight there, with a notice that they need to "confirm" the connection, and a button to send them the invite link.
- Ability to click on links in messages to open them in external browser
- Add basic search to conversation list, only matches conversation titles right now
- Translations for German, Spanish, French, Italian, Bulgarian, Norwegian, Romanian, Danish, Swedish, Slovak
- Many more small UI improvements and fixes

### Fixed
- Copying and pasting invite codes in Tauri android
- Make sure mobile keyboard never covers content
- Allow for scrolling long member list for conversation
- Correctly sanitize html in message content, allowing for safe tags

## [0.5.3-beta] - 2024-08-23

### Added
- First version of on device notifications

### Changed
- Improved flow and UI of creating and editing contacts

### Fixed
- Syncing of images with messages
- Make sure invited contacts appear after creating a private conversation

## [0.5.2-beta] - 2024-08-20

### Added
- Light mode and dark mode themes, which respect the OS theme setting

### Changed
- Lots of little UI tweaks and improvements

### Fixed
- Wrapping of long words in messages
- Removed scrollbar on splashscreen

## [0.5.1-beta] - 2024-08-17

### Added
- Localize/Internationalize  Start with english and german locales, pending the actual German translations.

### Changed
- Display name and avatar from a local contact first, then from the agent's profile if there is no contact for them
- When there are multiple messages in a 5 minute period from the same person don't display their name and avatar for every message

### Fixed
- Correctly escape content when displaying it in the UI
- Show correct most recent message in Inbox
- Show correct unread status in Inbox
- Sorting conversations in the inbox according to most recent activity

## [0.5.0-beta] - 2024-08-07
First public Beta release of Relay! Includes profile creation and editing, private conversations with selected contacts, group conversations with invited links, contact book, image attachments and more.