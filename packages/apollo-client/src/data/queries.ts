import { DocumentNode, GraphQLError, ExecutionResult } from 'graphql';
import { isEqual } from 'apollo-utilities';

import { NetworkStatus } from '../core/networkStatus';
import { ExecutionPatchResult, isPatch } from '../core/types';
import { hasDirectives } from 'apollo-utilities';

export type QueryStoreValue = {
  document: DocumentNode;
  isDeferred: boolean;
  variables: Object;
  previousVariables?: Object | null;
  networkStatus: NetworkStatus;
  networkError?: Error | null;
  graphQLErrors?: ReadonlyArray<GraphQLError>;
  loadingState?: Record<string, any>;
  compactedLoadingState?: Record<string, any>;
  metadata: any;
};

export class QueryStore {
  private store: { [queryId: string]: QueryStoreValue } = {};

  public getStore(): { [queryId: string]: QueryStoreValue } {
    return this.store;
  }

  public get(queryId: string): QueryStoreValue {
    return this.store[queryId];
  }

  public initQuery(query: {
    queryId: string;
    document: DocumentNode;
    storePreviousVariables: boolean;
    variables: Object;
    isPoll: boolean;
    isRefetch: boolean;
    metadata: any;
    fetchMoreForQueryId: string | undefined;
  }) {
    const previousQuery = this.store[query.queryId];

    if (
      previousQuery &&
      previousQuery.document !== query.document &&
      !isEqual(previousQuery.document, query.document)
    ) {
      // XXX we're throwing an error here to catch bugs where a query gets overwritten by a new one.
      // we should implement a separate action for refetching so that QUERY_INIT may never overwrite
      // an existing query (see also: https://github.com/apollostack/apollo-client/issues/732)
      throw new Error(
        'Internal Error: may not update existing query string in store',
      );
    }

    let isSetVariables = false;

    let previousVariables: Object | null = null;
    if (
      query.storePreviousVariables &&
      previousQuery &&
      previousQuery.networkStatus !== NetworkStatus.loading
      // if the previous query was still loading, we don't want to remember it at all.
    ) {
      if (!isEqual(previousQuery.variables, query.variables)) {
        isSetVariables = true;
        previousVariables = previousQuery.variables;
      }
    }

    // TODO break this out into a separate function
    let networkStatus;
    if (isSetVariables) {
      networkStatus = NetworkStatus.setVariables;
    } else if (query.isPoll) {
      networkStatus = NetworkStatus.poll;
    } else if (query.isRefetch) {
      networkStatus = NetworkStatus.refetch;
      // TODO: can we determine setVariables here if it's a refetch and the variables have changed?
    } else {
      networkStatus = NetworkStatus.loading;
    }

    let graphQLErrors: ReadonlyArray<GraphQLError> = [];
    if (previousQuery && previousQuery.graphQLErrors) {
      graphQLErrors = previousQuery.graphQLErrors;
    }

    // XXX right now if QUERY_INIT is fired twice, like in a refetch situation, we just overwrite
    // the store. We probably want a refetch action instead, because I suspect that if you refetch
    // before the initial fetch is done, you'll get an error.
    this.store[query.queryId] = {
      document: query.document,
      isDeferred: query.document.definitions
        ? hasDirectives(['defer'], query.document)
        : false,
      variables: query.variables,
      previousVariables,
      networkError: null,
      graphQLErrors: graphQLErrors,
      networkStatus,
      metadata: query.metadata,
    };

    // If the action had a `moreForQueryId` property then we need to set the
    // network status on that query as well to `fetchMore`.
    //
    // We have a complement to this if statement in the query result and query
    // error action branch, but importantly *not* in the client result branch.
    // This is because the implementation of `fetchMore` *always* sets
    // `fetchPolicy` to `network-only` so we would never have a client result.
    if (
      typeof query.fetchMoreForQueryId === 'string' &&
      this.store[query.fetchMoreForQueryId]
    ) {
      this.store[query.fetchMoreForQueryId].networkStatus =
        NetworkStatus.fetchMore;
    }
  }

  public markQueryComplete(queryId: string) {
    if (!this.store[queryId]) return;
    this.store[queryId].networkStatus = NetworkStatus.ready;
  }

  public updateLoadingState(
    queryId: string,
    loadingState: Record<string, any>,
  ) {
    if (!this.store[queryId]) return;
    this.store[queryId].loadingState = loadingState;
    this.store[queryId].compactedLoadingState = this.compactLoadingStateTree(
      loadingState,
    );
  }

  public markQueryResult(
    queryId: string,
    result: ExecutionResult | ExecutionPatchResult,
    fetchMoreForQueryId: string | undefined,
    isDeferred: boolean,
    loadingState?: Record<string, any>,
  ) {
    if (!this.store || !this.store[queryId]) return;

    // Store loadingState along with a compacted version of it
    if (isDeferred && loadingState) {
      this.store[queryId].loadingState = loadingState;
      this.store[queryId].compactedLoadingState = this.compactLoadingStateTree(
        loadingState,
      );
    }

    if (isDeferred && isPatch(result)) {
      // Merge graphqlErrors from patch, if any
      if (result.errors) {
        const errors: GraphQLError[] = [];
        this.store[queryId].graphQLErrors!.forEach(error => {
          errors.push(error);
        });
        result.errors.forEach(error => {
          errors.push(error);
        });
        this.store[queryId].graphQLErrors = errors;
      }
    }

    this.store[queryId].networkError = null;
    this.store[queryId].graphQLErrors =
      result.errors && result.errors.length ? result.errors : [];
    this.store[queryId].previousVariables = null;
    this.store[queryId].networkStatus = isDeferred
      ? NetworkStatus.partial
      : NetworkStatus.ready;

    // If we have a `fetchMoreForQueryId` then we need to update the network
    // status for that query. See the branch for query initialization for more
    // explanation about this process.
    if (
      typeof fetchMoreForQueryId === 'string' &&
      this.store[fetchMoreForQueryId]
    ) {
      this.store[fetchMoreForQueryId].networkStatus = NetworkStatus.ready;
    }
  }

  public markQueryError(
    queryId: string,
    error: Error,
    fetchMoreForQueryId: string | undefined,
  ) {
    if (!this.store || !this.store[queryId]) return;

    this.store[queryId].networkError = error;
    this.store[queryId].networkStatus = NetworkStatus.error;

    // If we have a `fetchMoreForQueryId` then we need to update the network
    // status for that query. See the branch for query initialization for more
    // explanation about this process.
    if (typeof fetchMoreForQueryId === 'string') {
      this.markQueryResultClient(fetchMoreForQueryId, true);
    }
  }

  public markQueryResultClient(
    queryId: string,
    complete: boolean,
    loadingState?: Record<string, any>,
  ) {
    if (!this.store || !this.store[queryId]) return;

    // Store loadingState if it is passed in
    if (loadingState) {
      this.store[queryId].loadingState = loadingState;
      this.store[queryId].compactedLoadingState = this.compactLoadingStateTree(
        loadingState,
      );
    }

    this.store[queryId].networkError = null;
    this.store[queryId].previousVariables = null;
    this.store[queryId].networkStatus = complete
      ? NetworkStatus.ready
      : NetworkStatus.loading;
  }

  public stopQuery(queryId: string) {
    delete this.store[queryId];
  }

  public reset(observableQueryIds: string[]) {
    // keep only the queries with query ids that are associated with observables
    this.store = Object.keys(this.store)
      .filter(queryId => {
        return observableQueryIds.indexOf(queryId) > -1;
      })
      .reduce(
        (res, key) => {
          // XXX set loading to true so listeners don't trigger unless they want results with partial data
          res[key] = {
            ...this.store[key],
            networkStatus: NetworkStatus.loading,
          };

          return res;
        },
        {} as { [queryId: string]: QueryStoreValue },
      );
  }

  /**
   * Given a loadingState tree, it returns a compacted version of it that
   * reduces the amount of boilerplate code required to access nested fields.
   * The structure of this will mirror the response data, with deferred fields
   * set to undefined until its patch is received.
   */
  private compactLoadingStateTree(
    loadingState?: Record<string, any>,
  ): Record<string, any> | undefined {
    if (!loadingState) return loadingState;
    const state: Record<string, any> = {};

    for (let key in loadingState) {
      const o = loadingState[key];
      if (o._loading) {
        continue;
      }
      if (o._children) {
        if (Array.isArray(o._children)) {
          state[key] = o._children.map((c: any) =>
            this.compactLoadingStateTree(c),
          );
        } else {
          state[key] = this.compactLoadingStateTree(o._children);
        }
        continue;
      }
      state[key] = true;
    }

    return state;
  }
}
