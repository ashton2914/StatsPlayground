import {test,expect} from '@playwright/experimental-ct-react';
import {TableDirectoryHarness} from './TableDirectoryHarness';
test('table owns both graphs, all analyses and tabulate; transform and literal rename remain accessible',async({mount})=>{
 const c=await mount(<TableDirectoryHarness/>);await expect(c.getByText('Experiment.sptb',{exact:true})).toBeVisible();await expect(c.getByTestId('directory-document-g')).toHaveCount(0);await c.getByLabel('Expand table').first().click();
 for(const id of ['g','gn','dist','fit','model','hyp','tab']){await c.getByTestId(`directory-document-${id}`).click();await expect(c.getByTestId('selected')).toHaveText(id);}
 await c.getByLabel('Transform: Subset').click();await expect(c.getByTestId('selected')).toHaveText('ab');
 await c.getByTestId('directory-document-A').dblclick();const input=c.getByTestId('directory-document-A').locator('input');await input.fill('Renamed.spgh');await input.press('Enter');await expect(c.getByText('Renamed.spgh',{exact:true})).toBeVisible();await expect(c.getByTestId('directory-document-g')).toBeVisible();
});
for(const id of ['A','B','g'])test(`drag ${id} moves the complete group into a renamed folder and back`,async({mount})=>{const c=await mount(<TableDirectoryHarness/>);await c.getByLabel('Folder name').fill('New/Nested');if(id==='g')await c.getByLabel('Expand table').first().click();await c.getByTestId(`directory-document-${id}`).dragTo(c.getByTestId('folder'));await expect(c.getByTestId('folder').getByTestId('directory-document-A')).toBeVisible();await expect(c.getByTestId('folder').getByTestId('directory-document-B')).toBeVisible();await expect(c.getByTestId('root').getByTestId('directory-document-X')).toBeVisible();await c.getByTestId('directory-document-B').dragTo(c.getByTestId('root-drop-zone'));await expect(c.getByTestId('root').getByTestId('directory-document-A')).toBeVisible();});
test('failed move preserves visible location, document row cannot receive a group, readonly blocks drag',async({mount})=>{const c=await mount(<TableDirectoryHarness fail/>);await c.getByTestId('directory-document-A').dragTo(c.getByTestId('directory-document-X'));await expect(c.getByTestId('calls')).toHaveText('0');await c.getByTestId('directory-document-B').dragTo(c.getByTestId('folder'));await expect(c.getByRole('alert')).toHaveText('move failed');await expect(c.getByTestId('root').getByTestId('directory-document-B')).toBeVisible();await c.update(<TableDirectoryHarness readOnly/>);await expect(c.getByTestId('directory-document-A')).toHaveAttribute('draggable','false');});

test('DataLink opens from its own row and reimports from the linked table group',async({mount})=>{
 const c=await mount(<TableDirectoryHarness/>);
 const group=c.getByTestId('directory-group-X');
 const table=group.getByTestId('directory-document-X');
 const source=group.getByRole('button',{name:'Cell A source',exact:true});
 await expect(table).toBeVisible();
 await expect(source).toHaveCSS('border-top-width','0px');
 await expect(source).toHaveCSS('background-color','rgba(0, 0, 0, 0)');
 await group.getByLabel('Expand table').click();
 const graph=group.getByTestId('directory-document-linked-graph');
 await expect(graph).toBeVisible();
 const sourceBox=await source.locator('.ds-icon').boundingBox();
 const tableBox=await table.locator('.ds-icon').boundingBox();
 const graphBox=await graph.locator('.ds-icon').boundingBox();
 expect(sourceBox!.x).toBeCloseTo(tableBox!.x);
 expect(graphBox!.x).toBeGreaterThan(tableBox!.x+10);
 await group.getByRole('button',{name:'Cell A source',exact:true}).click();
 await expect(c.getByTestId('selected')).toHaveText('X,open');
 await group.getByLabel('Reimport: Cell A source').click();
 await expect(c.getByTestId('selected')).toHaveText('X,reimport');
 await c.update(<TableDirectoryHarness readOnly/>);
 await expect(group.getByLabel('Reimport: Cell A source')).toBeDisabled();
});
