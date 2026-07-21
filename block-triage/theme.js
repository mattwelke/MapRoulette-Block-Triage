// Shared by all three pages (index.html, local.html, live.html) - loaded
// early and synchronously (no async/defer) in <head>, before style.css's
// content paints, so the right theme applies immediately with no flash of
// the wrong one. Not a build artifact; this same file is used everywhere.
//
// Three states, cycled by any [data-theme-toggle] button:
//   - Auto (default, nothing stored)  - follows prefers-color-scheme
//   - Light                            - forces light regardless of system
//   - Dark                             - forces dark regardless of system
//
// "Auto" is represented by the ABSENCE of a stored preference (and no
// data-theme attribute on <html>), letting style.css's
// @media (prefers-color-scheme: dark) rule decide. "Light"/"Dark" set
// data-theme explicitly, which style.css's [data-theme="..."] rules match
// with higher precedence than the media query.
(function () {
  "use strict";

  var STORAGE_KEY = "block-triage:theme";

  function getStored() {
    try {
      var value = localStorage.getItem(STORAGE_KEY);
      return value === "light" || value === "dark" ? value : null;
    } catch (err) {
      return null; // localStorage unavailable (private browsing, etc.) - just behave as Auto
    }
  }

  function setStored(value) {
    try {
      if (value === null) localStorage.removeItem(STORAGE_KEY);
      else localStorage.setItem(STORAGE_KEY, value);
    } catch (err) {
      // ignore - the theme will just reset to Auto next load
    }
  }

  function apply(pref) {
    if (pref === "light" || pref === "dark") {
      document.documentElement.setAttribute("data-theme", pref);
    } else {
      document.documentElement.removeAttribute("data-theme");
    }
  }

  // Apply immediately - this script is loaded synchronously before the
  // rest of the page paints, so there's nothing to flash.
  apply(getStored());

  function systemPrefersDark() {
    return !!(window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
  }

  function labelFor(pref) {
    if (pref === "light") return "Theme: Light";
    if (pref === "dark") return "Theme: Dark";
    return "Theme: Auto (" + (systemPrefersDark() ? "Dark" : "Light") + ")";
  }

  function updateButtons() {
    var label = labelFor(getStored());
    var buttons = document.querySelectorAll("[data-theme-toggle]");
    for (var i = 0; i < buttons.length; i++) {
      buttons[i].textContent = label;
      buttons[i].title = "Click to switch between automatic, light, and dark themes.";
    }
  }

  function cycle() {
    var pref = getStored();
    var next = pref === null ? "light" : pref === "light" ? "dark" : null;
    setStored(next);
    apply(next);
    updateButtons();
  }

  function wireUp() {
    var buttons = document.querySelectorAll("[data-theme-toggle]");
    for (var i = 0; i < buttons.length; i++) {
      buttons[i].addEventListener("click", cycle);
    }
    updateButtons();
  }

  if (window.matchMedia) {
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", function () {
      // The CSS media query already re-colors everything on its own; this
      // just keeps a visible "Auto (...)" button label in sync with it.
      if (getStored() === null) updateButtons();
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", wireUp);
  } else {
    wireUp();
  }
})();
