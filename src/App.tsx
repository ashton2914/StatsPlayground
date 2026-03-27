import "./App.css";
import { useProjectStore } from "@/stores/useProjectStore";
import { WelcomePage } from "@/components/WelcomePage";
import { Workspace } from "@/components/Workspace";

function App() {
  const project = useProjectStore((s) => s.project);

  if (!project) {
    return <WelcomePage />;
  }

  return <Workspace />;
}

export default App;
