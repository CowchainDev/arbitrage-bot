import { createContext, useContext, useState, type ReactNode } from "react";

export type DataSource = "live" | "demo" | null;

interface ConnectionStatusContextValue {
  dataSource: DataSource;
  setDataSource: (source: DataSource) => void;
}

const ConnectionStatusContext = createContext<ConnectionStatusContextValue>({
  dataSource: null,
  setDataSource: () => {},
});

export function ConnectionStatusProvider({ children }: { children: ReactNode }) {
  const [dataSource, setDataSource] = useState<DataSource>(null);
  return (
    <ConnectionStatusContext.Provider value={{ dataSource, setDataSource }}>
      {children}
    </ConnectionStatusContext.Provider>
  );
}

export function useConnectionStatus() {
  return useContext(ConnectionStatusContext);
}
