# Contributing to Session Tape

Use the Node version in `.nvmrc` and install the locked dependencies with `npm ci`. Run `npm test`, then `npm start` to exercise changes through the archive and compact panel. For a UI change, verify keyboard note submission and that both windows update after a save.

Keep database access in the main process. When a change affects storage, use a temporary profile to check that committed notes survive a restart. Use invented text and screenshots in shared examples.

A pull request should describe the user-visible change, how it was checked and which operating systems were exercised. For ideas beyond the starter, use the milestones in the README to describe where the proposal fits.
