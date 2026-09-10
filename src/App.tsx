import { useEffect, useRef } from "react";
import "./App.css";
import { useProjectStore } from "@/stores/useProjectStore";
import { useUpdatePreferencesStore } from "@/stores/useUpdatePreferencesStore";
import { useUpdateStore } from "@/stores/useUpdateStore";
import { runAutomaticUpdateCheck } from "@/services/automaticUpdateCheck";
import { Workspace } from "@/components/Workspace";

function App() {
  const project = useProjectStore((s) => s.project);
  const initProject = useProjectStore((s) => s.initProject);
  const automaticCheck = useUpdatePreferencesStore((state) => state.automaticCheck);
  const checkForUpdate = useUpdateStore((state) => state.check);
  const automaticCheckStarted = useRef(false);

  useEffect(() => {
    if (!project) {
      initProject();
    }
  }, []);

  useEffect(() => {
    runAutomaticUpdateCheck(automaticCheck, automaticCheckStarted, () => {
      void checkForUpdate("automatic");
    });
  }, [automaticCheck, checkForUpdate]);

  if (!project) {
    return null;
  }

  return <Workspace />;
}

export default App;
