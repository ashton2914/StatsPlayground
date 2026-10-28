import {useTranslation} from "react-i18next";
import type {RecoverableProjectDraft} from "../projectPersistence/startup";
interface Props {
 drafts:RecoverableProjectDraft[];
 busy?:boolean;
 error?:string|null;
 onRecover(id:string):void;
 onNew():void;
}
export function ProjectRecoveryChoice({drafts,busy=false,error,onRecover,onNew}:Props) {
 const {t}=useTranslation();
 return <div className="welcome-page"><div className="welcome-card">
  <h2>{t("welcome.recoverProject",{defaultValue:"Recover an unnamed project"})}</h2>
  <p>{t("welcome.recoverProjectHint",{defaultValue:"Your previous work is available. Choose a project to resume, or start a new one."})}</p>
  {error&&<p role="alert">{error}</p>}
  <div className="welcome-actions">
   {drafts.map((draft,index)=><button key={draft.recoveryId} className="btn-secondary" disabled={busy} onClick={()=>onRecover(draft.recoveryId)}>{draft.displayName||`${t("welcome.untitledProject",{defaultValue:"Untitled"})} ${index+1}`}</button>)}
   <button className="btn-primary" disabled={busy} onClick={onNew}>{t("welcome.newProject",{defaultValue:"New Project"})}</button>
  </div>
 </div></div>;
}
