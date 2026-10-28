import {useEffect,useRef,useState} from 'react';
import {useTranslation} from 'react-i18next';
import type {PersistenceSnapshot} from '../projectPersistence/coordinator';
interface Props {snapshot:PersistenceSnapshot;readOnly?:boolean;onRetry():Promise<void>}

/** Present durability state without exposing internal revisions or filesystem errors. */
export function ProjectPersistenceStatus({snapshot,readOnly=false,onRetry}:Props){
 const {t}=useTranslation();const active=useRef(true);const busy=useRef(false);const [retrying,setRetrying]=useState(false);const [failed,setFailed]=useState(false);
 useEffect(()=>{active.current=true;return()=>{active.current=false;};},[]);
 const hasError=snapshot.status==='error'||failed;
 const retry=async()=>{
  if(busy.current||readOnly)return;
  busy.current=true;setRetrying(true);setFailed(false);
  try{await onRetry();}catch{if(active.current)setFailed(true);}
  finally{busy.current=false;if(active.current)setRetrying(false);}
 };
 const state=hasError?'error':readOnly?'readOnly':snapshot.status;
 return <span className="project-persistence-status" role={hasError?'alert':'status'} aria-live={hasError?'assertive':'polite'}>
  <span>{t(`projectPersistence.${state}`)}</span>
  {hasError&&!readOnly&&<button type="button" disabled={retrying} onClick={()=>void retry()}>{t('projectPersistence.retry')}</button>}
 </span>;
}
