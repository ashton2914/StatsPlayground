import { useEffect } from "react";
import "./App.css";
import { useProjectStore } from "@/stores/useProjectStore";
import { Workspace } from "@/components/Workspace";

function App() {
  const project = useProjectStore((s) => s.project);
  const initProject = useProjectStore((s) => s.initProject);

  useEffect(() => {
    if (!project) {
      initProject();
    }
  }, []);

  if (!project) {
    return null;
  }

  return <Workspace />;
}

export default App;
