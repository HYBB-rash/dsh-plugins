import type {
  LocatedTrustedFact,
  LocatedTrustedFactReader,
  NavigationItem,
  NavigationSnapshot,
  NavigationSnapshotWriter,
} from './navigation-contract.ts'

export interface TrustedFactNavigationProjector {
  project(locatedFact: LocatedTrustedFact): NavigationItem
}

export class RebuildTrustedFactNavigation {
  constructor(
    private readonly reader: LocatedTrustedFactReader,
    private readonly projector: TrustedFactNavigationProjector,
    private readonly writer: NavigationSnapshotWriter,
  ) {}

  execute(): NavigationSnapshot {
    const input = this.reader.readLocatedSnapshot()
    const snapshot: NavigationSnapshot = {
      schemaVersion: 1,
      sourceRevision: input.sourceRevision,
      items: input.facts.map(fact => this.projector.project(fact)),
    }
    this.writer.replace(snapshot)
    return snapshot
  }
}
