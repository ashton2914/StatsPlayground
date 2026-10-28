export interface ProjectMigrationPreflight {
 formatVersion:string;
 destination:string;
 destinationExists:boolean;
 requiredWriter:number;
}
interface OpenDependencies {
 open(path:string):Promise<unknown>;
 preflight(source:string,destination?:string):Promise<ProjectMigrationPreflight>;
 confirm(info:ProjectMigrationPreflight):Promise<boolean>;
 chooseDestination(defaultPath:string):Promise<string|null>;
 migrate(source:string,destination:string,migrationId:string):Promise<unknown>;
 isCurrent():boolean;
}

/** Legacy conversion is an explicit copy operation; ordinary native opens bypass it. */
export async function openNativeProjectWithMigration(path:string,deps:OpenDependencies):Promise<boolean> {
 try {await deps.open(path);return true;}
 catch(error) {if(!String(error).includes("project_requires_migration"))throw error;}
 const assertCurrent=()=>{if(!deps.isCurrent())throw new Error("project_migration_session_changed");};
 assertCurrent();
 const info=await deps.preflight(path);assertCurrent();
 const accepted=await deps.confirm(info);assertCurrent();
 if(!accepted)return false;
 const destination=await deps.chooseDestination(info.destination);assertCurrent();
 if(!destination)return false;
 const target=await deps.preflight(path,destination);assertCurrent();
 if(target.destinationExists)throw new Error("project_migration_destination_exists");
 await deps.migrate(path,target.destination,crypto.randomUUID());
 return true;
}
