"use client";

import * as React from "react";
import { useState } from "react";
import Check from "@mui/icons-material/Check";
import DarkMode from "@mui/icons-material/DarkMode";
import LightMode from "@mui/icons-material/LightMode";
import NightsStay from "@mui/icons-material/NightsStay";
import WbTwilight from "@mui/icons-material/WbTwilight";
import IconButton from "@mui/material/IconButton";
import ListItemIcon from "@mui/material/ListItemIcon";
import Menu from "@mui/material/Menu";
import MenuItem from "@mui/material/MenuItem";
import { useColorScheme } from "@mui/material/styles";
import {
  THEME_CHOICES,
  type ThemeChoice,
  choiceToState,
  stateToChoice,
  THEME_COLOR_BY_SCHEME,
  type SchemeName,
} from "../theme-selection";

interface ChoiceMeta {
  label: string;
  Icon: typeof LightMode;
}

const CHOICE_META: Record<ThemeChoice, ChoiceMeta> = {
  "current-light": { label: "Current light", Icon: LightMode },
  "current-dark": { label: "Current dark", Icon: DarkMode },
  "sunfade-light": { label: "Sunfade light", Icon: WbTwilight },
  /* NightsStay differentiates the collapsed Sunfade dark trigger from the
   * Sunfade light one (a sun on the horizon). */
  "sunfade-dark": { label: "Sunfade dark", Icon: NightsStay },
};

const CHOICE_LABELS: Record<ThemeChoice, string> = {
  "current-light": "Theme: Current light",
  "current-dark": "Theme: Current dark",
  "sunfade-light": "Theme: Sunfade light",
  "sunfade-dark": "Theme: Sunfade dark",
};

export function ThemeSelector() {
  const { mode, colorScheme, setMode, setColorScheme } = useColorScheme();
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null);
  /*
   * Per-instance menu id.  The selector is rendered in more than one place
   * (sidebar, drawer, signin page), so a single shared constant could yield
   * duplicate DOM ids when an old and a new instance briefly coexist during
   * route/layout transitions.  useId is stable across renders and unique
   * per instance.
   */
  const menuId = React.useId();

  /*
   * `mode` and `colorScheme` are undefined during the server render and the
   * first client render; fall back to the default (Current dark) so that the
   * server markup and the first client render agree.  The colour scheme
   * itself is already correct before paint via the init script.
   */
  const selected = stateToChoice(mode, colorScheme);
  const meta = CHOICE_META[selected];
  const SelectedIcon = meta.Icon;

  const applyChoice = (choice: ThemeChoice) => {
    setAnchorEl(null);
    if (choice === selected) return;
    const { mode: nextMode, scheme } = choiceToState(choice);
    /*
     * Mode first, colour scheme second: the override is stored in a per-mode
     * key, so the mode has to be updated before the override is written.
     */
    setMode(nextMode);
    setColorScheme(scheme);
  };

  return (
    <>
      <IconButton
        size="large"
        aria-label={CHOICE_LABELS[selected]}
        aria-haspopup="menu"
        aria-expanded={Boolean(anchorEl)}
        aria-controls={anchorEl ? menuId : undefined}
        title={CHOICE_LABELS[selected]}
        onClick={(event) => setAnchorEl(event.currentTarget)}
        sx={{ minWidth: 48, minHeight: 48 }}
      >
        <SelectedIcon />
      </IconButton>
      <Menu
        id={menuId}
        anchorEl={anchorEl}
        open={Boolean(anchorEl)}
        onClose={() => setAnchorEl(null)}
        anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
        transformOrigin={{ vertical: "top", horizontal: "right" }}
      >
        {THEME_CHOICES.map((choice) => {
          const item = CHOICE_META[choice];
          const Icon = item.Icon;
          return (
            <MenuItem
              key={choice}
              role="menuitemradio"
              aria-checked={choice === selected}
              selected={choice === selected}
              onClick={() => applyChoice(choice)}
            >
              <ListItemIcon>
                <Icon fontSize="small" />
              </ListItemIcon>
              {item.label}
              {choice === selected && (
                <ListItemIcon sx={{ ml: "auto", minWidth: 0 }}>
                  <Check fontSize="small" />
                </ListItemIcon>
              )}
            </MenuItem>
          );
        })}
      </Menu>
    </>
  );
}

/*
 * Keeps the browser-chrome theme-colour <meta> tags in step with the colour
 * scheme.  The pre-paint inline script in app/layout.tsx mirrors this for the
 * very first render.
 */
export function ThemeColorSync() {
  const { colorScheme } = useColorScheme();
  React.useEffect(() => {
    if (!colorScheme) return;
    const color = THEME_COLOR_BY_SCHEME[colorScheme as SchemeName];
    if (!color) return;
    document
      .querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')
      .forEach((meta) => {
        meta.setAttribute("content", color);
      });
  }, [colorScheme]);
  return null;
}
