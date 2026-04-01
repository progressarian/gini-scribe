import "./styles/Companion.css";
import { useEffect } from "react";
import { Outlet } from "react-router-dom";
import useCompanionStore from "./stores/companionStore";
import CompanionNavBar from "./companion/CompanionNavBar";

export default function Companion() {
  const loadPatients = useCompanionStore((s) => s.loadPatients);

  useEffect(() => {
    loadPatients();
  }, []);

  return (
    <div className="companion">
      <Outlet />
      <CompanionNavBar />
    </div>
  );
}
