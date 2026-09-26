import { createContext, useContext, type ReactNode } from "react";
import { api, type Device, type Me } from "../api";
import { useLive } from "../lib/live";

export type SetMe = (update: Me | ((current: Me) => Me)) => void;
type Session = {
  me: Me;
  refreshMe: () => Promise<void>;
  setMe: SetMe;
  devices: Device[];
  devicesLoading: boolean;
  devicesError: string;
  reloadDevices: () => void;
};
const SessionContext = createContext<Session | null>(null);

export function SessionProvider({
  me,
  setMe,
  refreshMe,
  children,
}: {
  me: Me;
  setMe: SetMe;
  refreshMe: () => Promise<void>;
  children: ReactNode;
}) {
  const devices = useLive(api.devices.list, {}, ["devices"], [] as Device[]);
  return (
    <SessionContext.Provider
      value={{
        me,
        setMe,
        refreshMe,
        devices: devices.data,
        devicesLoading: devices.loading,
        devicesError: devices.error,
        reloadDevices: devices.reload,
      }}
    >
      {children}
    </SessionContext.Provider>
  );
}
export function useSession() {
  const value = useContext(SessionContext);
  if (!value) throw new Error("Session unavailable");
  return value;
}
// Destinations only list devices that have Relay open right now, never this one.
export function useOnlineDevices() {
  const { devices } = useSession();
  return devices.filter((d) => d.online && !d.current);
}
