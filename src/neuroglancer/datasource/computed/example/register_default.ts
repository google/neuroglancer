import {ExampleComputationProvider} from 'neuroglancer/datasource/computed/example/frontend';
import {ComputedDataSource} from 'neuroglancer/datasource/computed/frontend';

ComputedDataSource.registerComputation('example', new ExampleComputationProvider());
