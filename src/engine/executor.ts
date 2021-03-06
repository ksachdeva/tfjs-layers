/**
 * @license
 * Copyright 2018 Google LLC
 *
 * Use of this source code is governed by an MIT-style
 * license that can be found in the LICENSE file or at
 * https://opensource.org/licenses/MIT.
 * =============================================================================
 */

/**
 * Executor: Evaluates SymbolicTensor based on feeds.
 */

import {cast, dispose, memory, Tensor, util} from '@tensorflow/tfjs-core';

import {ValueError} from '../errors';
import {Kwargs} from '../types';
import {toList} from '../utils/generic_utils';

import {InputLayer} from './input_layer';
import {SymbolicTensor} from './topology';

/**
 * Helper function to check the dtype and shape compatibility of a feed value.
 */
function assertFeedCompatibility(key: SymbolicTensor, val: Tensor): Tensor {
  // 1. Check shape compatibility.  If shapes are not compatible, error.
  if (key.shape != null) {
    if (key.shape.length !== val.shape.length) {
      throw new ValueError(
          `The rank of feed (${val.shape.length}) does not match the rank of ` +
          `the key (${key.shape.length}).`);
    }

    for (let i = 0; i < key.shape.length; ++i) {
      if (key.shape[i] != null && key.shape[i] !== val.shape[i]) {
        throw new ValueError(
            `The ${i}-th dimension of the feed (${val.shape[i]}) is ` +
            `incompatible with that of the key (${key.shape[i]}).`);
      }
    }
  }
  // 2. Check dtype compatibility.
  if (key.dtype == null || key.dtype === val.dtype) {
    //  2a.  If types match, return val tensor as is.
    return val;
  }
  try {
    //  2b. Attempt to convert to expected type.
    return cast(val, key.dtype);
  } catch (err) {
    //  2c. If conversion fails, return helpful error.
    throw new ValueError(
        `The dtype of the feed (${val.dtype}) can not be cast to the dtype ` +
        `of the key '${key.name}' (${key.dtype}).`);
  }
}

/**
 * A concrete Tensor value for a symbolic tensor as the key.
 */
export interface Feed {
  key: SymbolicTensor;
  value: Tensor;
}

/**
 * FeedDict: A mapping from unique SymbolicTensors to feed values for them.
 * A feed value is a concrete value represented as an `Tensor`.
 */
export class FeedDict {
  private id2Value: {[id: number]: Tensor} = {};
  private name2Id: {[name: string]: number} = {};

  /**
   * Constructor, optionally does copy-construction.
   * @param feeds An Array of `Feed`s, or another `FeedDict`, in which case
   *   copy-construction will be performed.
   */
  constructor(feeds?: Feed[]|FeedDict) {
    if (feeds instanceof FeedDict) {
      for (const id in feeds.id2Value) {
        this.id2Value[id] = feeds.id2Value[id];
      }
    } else {
      if (feeds == null) {
        return;
      }
      for (const feed of feeds) {
        this.add(feed.key, feed.value);
      }
    }
  }

  /**
   * Add a key-value pair to the FeedDict.
   * @param key The key of the feed.
   * @param value The value of the feed.
   * @returns This `FeedDict`.
   * @throws ValueError: If the key `SymbolicTensor` already exists in the
   *   `FeedDict`.
   */
  add(key: SymbolicTensor, value: Tensor): FeedDict {
    if (this.id2Value[key.id] == null) {
      this.id2Value[key.id] = assertFeedCompatibility(key, value);
      this.name2Id[key.name] = key.id;
    } else {
      throw new ValueError(`Duplicate key: name=${key.name}, id=${key.id}`);
    }
    return this;
  }

  /**
   * Add a Feed to the FeedDict.
   * @param feed The new `Feed` to add.
   * @returns This `FeedDict`.
   */
  addFeed(feed: Feed) {
    this.add(feed.key, feed.value);
  }

  /**
   * Probe whether a key already exists in the FeedDict.
   * @param key
   */
  hasKey(key: SymbolicTensor): boolean {
    return this.id2Value[key.id] != null;
  }

  /**
   * Get all the SymbolicTensor available in this FeedDict.
   */
  names(): string[] {
    return Object.keys(this.name2Id);
  }

  /**
   * Get the feed value for given key.
   * @param key The SymbolicTensor, or its name (as a string), of which the
   *     value is sought.
   * @returns If `key` exists, the corresponding feed value.
   * @throws ValueError: If `key` does not exist in this `FeedDict`.
   */
  getValue(key: SymbolicTensor|string): Tensor {
    if (key instanceof SymbolicTensor) {
      if (this.id2Value[key.id] == null) {
        throw new ValueError(`Nonexistent key: ${key.name}`);
      } else {
        return this.id2Value[key.id];
      }
    } else {
      const id = this.name2Id[key];
      if (id == null) {
        throw new ValueError(`Feed dict has no SymbolicTensor name: ${key}`);
      }
      return this.id2Value[id];
    }
  }
}

// Cache for topologically sorted SymbolicTensors for given execution
// targets (i.e., fetches).
const cachedSorted: {[concatFetchNames: string]: SymbolicTensor[]} = {};

// Cache for recipient count maps for given execution targets (i.e., fetches).
const cachedRecipientCounts:
    {[concatFetchNames: string]: {[fetchName: string]: number}} = {};

/**
 * Interface for the optional object used for probing the memory
 * usage and other statistics during execution.
 */
export interface ExecutionProbe {
  /**
   * Maximum number of tensors that exist during all steps of the
   * execution. Tensor counts are measured at the beginning of every
   * step.
   */
  maxNumTensors?: number;

  /**
   * Minimum number of tensors that exist during all steps of the
   * execution. Tensor counts are measured at the beginning of every
   * step.
   */
  minNumTensors?: number;
}

/**
 * Execute a SymbolicTensor by using concrete feed values.
 *
 * A `SymbolicTensor` object is a node in a computation graph of TF.js
 * Layers. The object is backed by a source layer and input
 * `SymbolicTensor`s to the source layer. This method evaluates
 * the `call()` method of the source layer, using concrete values of the
 * inputs obtained from either
 * * `feedDict`, if the input key exists in `feedDict`, or else,
 * * a recursive call to `execute()` itself.
 *
 * @param x: The `SymbolicTensor` to execute.
 * @param feedDict: The feed values, as base condition of the recursion.
 *   execution.
 * @param kwargs: Optional keyword arguments.
 * @param probe: A probe object (of interface `ExecutionProbe`) used for
 *   testing memory footprint of `execute` calls.
 * @returns Result of the execution.
 * @throws ValueError: If any `SymbolicTensor`s from `InputLayer`s
 *   encountered during the execution lacks a feed value in `feedDict`.
 */
export function execute(
    fetches: SymbolicTensor|SymbolicTensor[], feedDict: FeedDict,
    kwargs?: Kwargs, probe?: ExecutionProbe): Tensor|
    Tensor[]|[Tensor | Tensor[]] {
  const training: boolean = kwargs == null ? false : kwargs['training'];

  const arrayFetches = Array.isArray(fetches);
  const fetchArray: SymbolicTensor[] =
      arrayFetches ? fetches as SymbolicTensor[] : [fetches as SymbolicTensor];

  const outputNames = fetchArray.map(t => t.name);
  const finalOutputs: Tensor[] = [];
  const feedNames = feedDict.names();
  for (const outputName of outputNames) {
    if (feedNames.indexOf(outputName) !== -1) {
      finalOutputs.push(feedDict.getValue(outputName));
    } else {
      finalOutputs.push(null);
    }
  }

  if (probe != null) {
    // For optional probing of memory footprint during execution.
    probe.maxNumTensors = -Infinity;
    probe.minNumTensors = Infinity;
  }

  // Check cache.
  const fetchAndFeedKey =
      outputNames.join(',') + '|' + feedDict.names().join(',');
  let sorted: SymbolicTensor[];
  let recipientCounts: {[fetchName: string]: number};
  if (cachedSorted[fetchAndFeedKey] == null) {
    // Cache doesn't contain the desired combination of fetches. Compute
    // topological sort for the combination for the first time.
    const out = getTopologicalSortAndRecipientCounts(fetchArray, feedDict);
    sorted = out.sorted;
    recipientCounts = out.recipientCounts;

    // Store results in cache for future use.
    cachedSorted[fetchAndFeedKey] = sorted;
    cachedRecipientCounts[fetchAndFeedKey] = recipientCounts;
  }
  sorted = cachedSorted[fetchAndFeedKey];
  recipientCounts = {};
  if (!training) {
    Object.assign(recipientCounts, cachedRecipientCounts[fetchAndFeedKey]);
  }

  const internalFeedDict = new FeedDict(feedDict);

  // Start iterative execution on the topologically-sorted SymbolicTensors.
  for (let i = 0; i < sorted.length; ++i) {
    if (probe != null) {
      // For optional probing of memory usage during execution.
      const numTensors = memory().numTensors;
      if (numTensors > probe.maxNumTensors) {
        probe.maxNumTensors = numTensors;
      }
      if (numTensors < probe.minNumTensors) {
        probe.minNumTensors = numTensors;
      }
    }

    const symbolic = sorted[i];
    if (symbolic.sourceLayer instanceof InputLayer) {
      continue;
    }
    const inputValues: Tensor[] = [];
    const tensorsToDispose: Tensor[] = [];

    for (const input of symbolic.inputs) {
      const value = internalFeedDict.getValue(input);
      inputValues.push(value);
      if (!training) {
        recipientCounts[input.name]--;
        if (recipientCounts[input.name] === 0 && !feedDict.hasKey(input) &&
            outputNames.indexOf(input.name) === -1 && !value.isDisposed) {
          // Keep track of Tensors to be disposed at the end of this execution.
          tensorsToDispose.push(value);
        }
      }
    }
    const output =
        toList(symbolic.sourceLayer.apply(inputValues, kwargs)) as Tensor[];
    const layerOutputs = getNodeOutputs(symbolic);
    const outputSymbolicTensors =
        Array.isArray(layerOutputs) ? layerOutputs : [layerOutputs];
    for (let i = 0; i < outputSymbolicTensors.length; ++i) {
      if (!internalFeedDict.hasKey(outputSymbolicTensors[i])) {
        internalFeedDict.add(outputSymbolicTensors[i], output[i]);
      }
      const index = outputNames.indexOf(outputSymbolicTensors[i].name);
      if (index !== -1) {
        finalOutputs[index] = output[i];
      }
    }

    if (!training) {
      // Clean up Tensors that are no longer needed.
      dispose(tensorsToDispose);
    }
  }

  return arrayFetches ? finalOutputs : finalOutputs[0];
}

type RecipientCounts = {
  [fetchName: string]: number
};

type RecipientMap = {
  [fetchName: string]: Set<string>;
};

/**
 * Sort the `SymbolicTensor`s topologically, for an array of fetches.
 *
 * This function calls getTopologicalSortAndRecipientCountsForOneFetch and
 * merges their results.
 *
 * @param fetch The array of fetches requested. Must be a non-empty array.
 * @param feedDict The dictionary of fed values.
 * @returns sorted: Topologically-sorted array of SymbolicTensors.
 *   recipientCounts: Recipient counts for all SymbolicTensors in `sorted`.
 */
function getTopologicalSortAndRecipientCounts(
    fetches: SymbolicTensor[], feedDict: FeedDict):
    {sorted: SymbolicTensor[], recipientCounts: RecipientCounts} {
  util.assert(
      fetches != null && fetches.length > 0,
      `Exepcted at least one fetch, got none`);

  let finalSorted: SymbolicTensor[] = [];
  let finalRecipientMap: RecipientMap = {};
  if (fetches.length === 1) {
    // Special-casing 1 fetch for efficiency.
    const out =
        getTopologicalSortAndRecipientCountsForOneFetch(fetches[0], feedDict);
    finalSorted = out.sorted;
    finalRecipientMap = out.recipientMap;
  } else {
    const visited = new Set<string>();
    for (const fetch of fetches) {
      const {sorted, recipientMap} =
          getTopologicalSortAndRecipientCountsForOneFetch(fetch, feedDict);

      // Merge sorted SymbolicTensor Arrays.
      for (const symbolicTensor of sorted) {
        if (!visited.has(symbolicTensor.name)) {
          finalSorted.push(symbolicTensor);
          visited.add(symbolicTensor.name);
        }
      }

      // Merge recipient maps.
      for (const name in recipientMap) {
        if (finalRecipientMap[name] == null) {
          finalRecipientMap[name] = new Set<string>();
        }
        recipientMap[name].forEach(
            recipient => finalRecipientMap[name].add(recipient));
      }
    }
  }
  return {
    sorted: finalSorted,
    recipientCounts: recipientMap2Counts(finalRecipientMap)
  };
}

function recipientMap2Counts(recipientMap: RecipientMap): RecipientCounts {
  const recipientCounts: RecipientCounts = {};
  for (const name in recipientMap) {
    recipientCounts[name] = recipientMap[name].size;
  }
  return recipientCounts;
}

/**
 * Sort the `SymbolicTensor`s topologically, for a single fetch.
 *
 * This helper function processes the upstream SymbolicTensors of a single
 * fetch.
 *
 * @param fetch The single fetch requested.
 * @param feedDict The dictionary of fed values.
 * @returns sorted: Topologically-sorted array of SymbolicTensors.
 *   recipientMap: Recipient names for all SymbolicTensors in `sorted`.
 */
function getTopologicalSortAndRecipientCountsForOneFetch(
    fetch: SymbolicTensor, feedDict: FeedDict):
    {sorted: SymbolicTensor[], recipientMap: RecipientMap} {
  const visited = new Set<string>();
  const sorted: SymbolicTensor[] = [];
  const recipientMap: RecipientMap = {};

  // Put keys of the feedDict into visited first, so they don't have to be
  // walked. This is needed in case where there are feeds for intermediate
  // SymbolicTensors of the graph.
  for (const key of feedDict.names()) {
    visited.add(key);
  }

  const stack: SymbolicTensor[] = [];
  const marks: number[] = [];

  // Initial population of stack and marks.
  stack.push(fetch);
  visited.add(fetch.name);

  while (stack.length > 0) {
    const top = stack[stack.length - 1];
    const topIsMarked = marks[marks.length - 1] === stack.length - 1;
    if (top.inputs.length === 0 || topIsMarked) {
      // Input SymbolicTensor or all children have been visited.
      stack.pop();
      sorted.push(top);
      if (topIsMarked) {
        marks.pop();
      }
    } else {
      // A non-input SymbolicTensor whose upstream SymbolicTensors haven't
      // been visited yet. Push them onto the stack.
      marks.push(stack.length - 1);
      for (const input of top.inputs) {
        // Increment the recipient count. Note that this needs to happen
        // regardless of whether the SymbolicTensor has been visited before.
        if (recipientMap[input.name] == null) {
          recipientMap[input.name] = new Set<string>();
        }
        recipientMap[input.name].add(top.name);

        if (visited.has(input.name)) {
          continue;  // Avoid repeated visits to the same SymbolicTensor.
        }
        stack.push(input);
        visited.add(input.name);
      }
    }
  }
  return {sorted, recipientMap};
}

/**
 * Get the symbolic output tensors of the node to which a given fetch belongs.
 * @param fetch The fetched symbolic tensor.
 * @returns The Array of symbolic tensors output by the node to which `fetch`
 *   belongs.
 */
function getNodeOutputs(fetch: SymbolicTensor): SymbolicTensor|
    SymbolicTensor[] {
  let layerOutputs: SymbolicTensor|SymbolicTensor[];
  if (fetch.sourceLayer.inboundNodes.length === 1) {
    layerOutputs = fetch.sourceLayer.output;
  } else {
    let nodeIndex: number = null;
    for (let i = 0; i < fetch.sourceLayer.inboundNodes.length; ++i) {
      for (const outputTensor of fetch.sourceLayer.inboundNodes[i]
               .outputTensors) {
        if (outputTensor.id === fetch.id) {
          nodeIndex = i;
          break;
        }
      }
    }
    layerOutputs = fetch.sourceLayer.getOutputAt(nodeIndex);
  }
  return layerOutputs;
}
