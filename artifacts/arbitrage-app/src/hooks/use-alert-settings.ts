import { useState } from "react";

const STORAGE_KEY = "alertSettings";

export interface AlertSettings {
  browserPushEnabled: boolean;
  soundEnabled: boolean;
}

const DEFAULTS: AlertSettings = {
  browserPushEnabled: false,
  soundEnabled: true,
};

function loadSettings(): AlertSettings {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (!stored) return DEFAULTS;
  try {
    return { ...DEFAULTS, ...JSON.parse(stored) };
  } catch {
    return DEFAULTS;
  }
}

function saveSettings(settings: AlertSettings) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
}

export function useAlertSettings() {
  const [settings, setSettings] = useState<AlertSettings>(loadSettings);

  const updateSettings = (patch: Partial<AlertSettings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      saveSettings(next);
      return next;
    });
  };

  const requestBrowserPermission = async (): Promise<boolean> => {
    if (!("Notification" in window)) return false;
    if (Notification.permission === "granted") return true;
    if (Notification.permission === "denied") return false;
    const result = await Notification.requestPermission();
    return result === "granted";
  };

  const enableBrowserPush = async (): Promise<boolean> => {
    const granted = await requestBrowserPermission();
    if (granted) {
      updateSettings({ browserPushEnabled: true });
    }
    return granted;
  };

  return {
    settings,
    updateSettings,
    enableBrowserPush,
    browserPushSupported: "Notification" in window,
    browserPermission: "Notification" in window ? Notification.permission : "denied",
  };
}
