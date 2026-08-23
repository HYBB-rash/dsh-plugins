export class PersonalFeedScopeInputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PersonalFeedScopeInputError'
  }
}

export class PersonalFeedScopeConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PersonalFeedScopeConflictError'
  }
}

export class PersonalFeedScopeStoreError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'PersonalFeedScopeStoreError'
  }
}
