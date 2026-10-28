import {formatProjectLifecycleError} from "@/projectPersistence/lifecycle";
import {createNativeWindowCloseHandler} from "@/projectPersistence/windowClose";
import { useEffect, useRef, useState } from "react";
import "./App.css";
import { useProjectStore } from "@/stores/useProjectStore";
import { useUpdatePreferencesStore } from "@/stores/useUpdatePreferencesStore";
import { useUpdateStore } from "@/stores/useUpdateStore";
import { runAutomaticUpdateCheck } from "@/services/automaticUpdateCheck";
import { Workspace } from "@/components/Workspace";
import {ProjectRecoveryChoice} from "@/components/ProjectRecoveryChoice";
import {createProjectStartup,type RecoverableProjectDraft} from "@/projectPersistence/startup";
import {nativeProjectLifecycle} from "@/projectPersistence/nativeLifecycle";
import {projectService} from "@/services/projectService";
import {useTranslation} from "react-i18next";

const startup=createProjectStartup({
  hasProject:()=>!!useProjectStore.getState().project,
  enabled:projectService.projectV5Enabled,
  listDrafts:projectService.listRecoverableProjectDrafts,
  createDraft:()=>nativeProjectLifecycle.createDraft(),
  legacyInit:()=>useProjectStore.getState().initProject(),
});

function App() {
  const project = useProjectStore((s) => s.project);
  const persistence=useProjectStore(state=>state.persistence);
  const sessionError=useProjectStore(state=>state.saveError);
  const {t,i18n}=useTranslation();
  const [drafts,setDrafts]=useState<RecoverableProjectDraft[]|null>(null);
  const [startupError,setStartupError]=useState<string|null>(null);
  const [startupBusy,setStartupBusy]=useState(false);
  const start=async()=>{
    setStartupBusy(true);setStartupError(null);
    try {const result=await startup.start();if(result.kind==="recovery") setDrafts(result.drafts);}
    catch(error) {setStartupError(formatProjectLifecycleError(error));}
    finally {setStartupBusy(false);}
  };
  const chooseDraft=async(recoveryId?:string)=>{
    if(startupBusy) return;
    setStartupBusy(true);setStartupError(null);
    try {if(recoveryId) await nativeProjectLifecycle.recoverDraft(recoveryId);else await nativeProjectLifecycle.createDraft();setDrafts(null);}
    catch(error) {setStartupError(formatProjectLifecycleError(error));}
    finally {setStartupBusy(false);}
  };
  const automaticCheck = useUpdatePreferencesStore((state) => state.automaticCheck);
  const checkForUpdate = useUpdateStore((state) => state.check);
  const automaticCheckStarted = useRef(false);

  useEffect(() => {
    if (!project) void start();
  }, []);

  useEffect(() => {
    runAutomaticUpdateCheck(automaticCheck, automaticCheckStarted, () => {
      void checkForUpdate("automatic");
    });
  }, [automaticCheck, checkForUpdate]);

  useEffect(()=>{
    let disposed=false;let unlisten:(()=>void)|undefined;
    void import("@tauri-apps/api/window").then(async({getCurrentWindow})=>{
      const appWindow=getCurrentWindow();
      const handler=createNativeWindowCloseHandler({
        getOwner:()=>useProjectStore.getState().persistence,
        flushEffects:async()=>{const {applicationRuntime}=await import("@/applicationCommands/applicationRuntime");await applicationRuntime.flushPendingEffects();},
        closeProject:async()=>{await nativeProjectLifecycle.closeProject();},
        destroy:()=>appWindow.destroy(),
        reportError:error=>{useProjectStore.setState({saveError:String(error)});window.alert(i18n.t("projectPersistence.closeError"));},
      });
      const stop=await appWindow.onCloseRequested(handler);
      if(disposed) stop();else unlisten=stop;
    }).catch(error=>useProjectStore.setState({saveError:String(error)}));
    return ()=>{disposed=true;unlisten?.();};
  },[i18n]);

  if (!project) {
    if(drafts) return <ProjectRecoveryChoice drafts={drafts} busy={startupBusy} error={startupError??sessionError} onRecover={id=>void chooseDraft(id)} onNew={()=>void chooseDraft()}/>;
    if(startupError||sessionError) return <div className="welcome-page"><div className="welcome-card"><p role="alert">{startupError??sessionError}</p><button disabled={startupBusy} onClick={()=>void start()}>{t("common.retry",{defaultValue:"Retry"})}</button></div></div>;
    return null;
  }

  return <Workspace key={persistence?.snapshot().epoch??"legacy"} />;
}

export default App;
