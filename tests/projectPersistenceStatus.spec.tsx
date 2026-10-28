import {test,expect} from '@playwright/experimental-ct-react';
import {ProjectPersistenceHarness} from './ProjectPersistenceHarness';

test('document status follows durable acknowledgements and a captured barrier leaves later edits pending',async({mount})=>{
 const app=await mount(<ProjectPersistenceHarness/>);await expect(app.getByRole('status')).toHaveText('All changes saved');
 await app.getByRole('button',{name:'Edit document'}).click();await expect(app.getByRole('status')).toHaveText('Changes waiting to save…');
 await app.getByRole('button',{name:'Save barrier'}).click();await expect(app.getByRole('status')).toHaveText('Saving…');
 await app.getByRole('button',{name:'Edit document'}).click();await app.getByRole('button',{name:'Acknowledge native write'}).click();
 await expect(app.getByTestId('barrier-complete')).toHaveText('true');await expect(app.getByRole('status')).toHaveText('Changes waiting to save…');
 await app.getByRole('button',{name:'Save barrier'}).click();await app.getByRole('button',{name:'Acknowledge native write'}).click();await expect(app.getByRole('status')).toHaveText('All changes saved');
});
test('save failure offers one safe retry without exposing a path or changing operation identity',async({mount})=>{
 const app=await mount(<ProjectPersistenceHarness/>);await app.getByRole('button',{name:'Edit document'}).click();await app.getByRole('button',{name:'Save barrier'}).click();await app.getByRole('button',{name:'Fail native write'}).click();
 await expect(app.getByRole('alert')).toContainText('Changes could not be saved.');await expect(app.getByRole('alert')).not.toContainText('/Users/');
 await app.getByRole('button',{name:'Retry saving',exact:true}).click();await expect(app.getByRole('status')).toHaveText('Saving…');
 await expect(app.getByTestId('request-identities')).toHaveText('["operation-1","operation-1"]');
 await app.getByRole('button',{name:'Acknowledge native write'}).click();await expect(app.getByRole('status')).toHaveText('All changes saved');
});
test('a retry acknowledgement from the retired owner does not change the new status',async({mount})=>{
 const app=await mount(<ProjectPersistenceHarness/>);await app.getByRole('button',{name:'Edit document'}).click();await app.getByRole('button',{name:'Save barrier'}).click();await app.getByRole('button',{name:'Fail native write'}).click();await app.getByRole('button',{name:'Retry saving',exact:true}).click();
 await app.getByRole('button',{name:'Switch owner'}).click();await expect(app.getByRole('status')).toHaveText('All changes saved');await app.getByRole('button',{name:'Acknowledge native write'}).click();await expect(app.getByRole('status')).toHaveText('All changes saved');
});
test('read-only project status does not imply automatic writes',async({mount})=>{
 const app=await mount(<ProjectPersistenceHarness readOnly/>);await expect(app.getByRole('status')).toHaveText('Read-only');await expect(app.getByRole('button',{name:'Retry saving',exact:true})).toHaveCount(0);
});

for(const [language,label] of [['en','All changes saved'],['zh-CN','所有更改已保存'],['zh-TW','所有變更已儲存']])test(`save status is translated in ${language}`,async({mount})=>{
 const app=await mount(<ProjectPersistenceHarness language={language}/>);await expect(app.getByRole('status')).toHaveText(label);
});
