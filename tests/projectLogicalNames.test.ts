import assert from 'node:assert/strict';
import {allocateProjectLogicalName} from '../src/utils/projectFileNaming';
assert.equal(allocateProjectLogicalName('Experiment.sptb',[]),'Experiment.sptb');assert.equal(allocateProjectLogicalName('Experiment',[]),'Experiment');assert.equal(allocateProjectLogicalName('Experiment.sptb',['experiment.sptb']),'Experiment.sptb-2');assert.throws(()=>allocateProjectLogicalName('bad/name',[]));console.log('logical names preserve literal suffixes and allocate collisions');
