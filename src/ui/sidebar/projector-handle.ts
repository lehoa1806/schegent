import type { Disposable } from '../../state/workspace-state';
import type { WorkflowSnapshot } from './snapshot';

export type ProjectorListener = (snapshot: WorkflowSnapshot) => void;

export interface ProjectorHandle {
  subscribe(listener: ProjectorListener): Disposable;
  getCurrentSnapshot(): WorkflowSnapshot;
}
