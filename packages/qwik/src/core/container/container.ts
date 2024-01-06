import { qError, QError_invalidRefValue, QError_missingObjectId } from '../error/error';
import { isQrl } from '../qrl/qrl-class';
import type { QRL } from '../qrl/qrl.public';
import type { QwikElement } from '../render/dom/virtual-element';
import { directGetAttribute } from '../render/fast-calls';
import {
  createSubscriptionManager,
  getProxyTarget,
  type SubscriberSignal,
  type SubscriptionManager,
} from '../state/common';
import { tryGetContext, type QContext } from '../state/context';
import type { Signal } from '../state/signal';
import type { ResourceReturnInternal, SubscriberEffect } from '../use/use-task';
import { fromKebabToCamelCase } from '../util/case';
import { isElement, isQwikElement } from '../util/element';
import { ELEMENT_ID_PREFIX, QContainerAttr } from '../util/markers';
import { isPromise } from '../util/promises';
import { seal } from '../util/qdev';
import { isFunction, isObject } from '../util/types';
import { getPromiseValue } from './pause';

export type GetObject = (id: string) => any;
export type GetObjID = (obj: any) => string | null;
export type MustGetObjID = (obj: any) => string;

/** @public */
export interface SnapshotMetaValue {
  w?: string; // q:watches
  s?: string; // q:seq
  h?: string; // q:host
  c?: string; // q:context
}

/** @public */
export type SnapshotMeta = Record<string, SnapshotMetaValue>;

/** @public */
export interface SnapshotState {
  ctx: SnapshotMeta;
  objs: any[];
  subs: any[];
}

/** @public */
export interface SnapshotListener {
  key: string;
  qrl: QRL<any>;
  el: Element;
}

/** @public */
export interface SnapshotResult {
  state: SnapshotState;
  funcs: string[];
  qrls: QRL[];
  objs: any[];
  resources: ResourceReturnInternal<any>[];
  mode: 'render' | 'listeners' | 'static';
}

export type ObjToProxyMap = WeakMap<any, any>;

/** @public */
export interface PauseContext {
  getObject: GetObject;
  meta: SnapshotMeta;
}

/** @public */
export interface ContainerState {
  /**
   * Used to keep track of text nodes which have bound text.
   *
   * The text is than reused during serialization in JSON as a reference. This way we can save on
   * not serializing the same string twice in HTML.
   */
  $textNodes$: Map<string, string>;
  readonly $containerEl$: Element;

  readonly $proxyMap$: ObjToProxyMap;
  $subsManager$: SubscriptionManager;

  readonly $taskNext$: Set<SubscriberEffect>;
  readonly $taskStaging$: Set<SubscriberEffect>;

  readonly $opsNext$: Set<SubscriberSignal>;

  readonly $hostsNext$: Set<QContext>;
  readonly $hostsStaging$: Set<QContext>;
  readonly $base$: string;

  $hostsRendering$: Set<QContext> | undefined;
  $renderPromise$: Promise<void> | undefined;

  $serverData$: Record<string, any>;
  $elementIndex$: number;

  $pauseCtx$: PauseContext | undefined;
  $styleMoved$: boolean;
  readonly $styleIds$: Set<string>;
  readonly $events$: Set<string>;
  readonly $inlineFns$: Map<string, number>;
  $mustGetObjId$: (obj: any) => string;
  $getObjId$: (obj: any) => string | null;
  $addObjRoot$(obj: any): string;
  $addObjRoots$(objs: any[], noSerialize: any[]): void;
}

const CONTAINER_STATE = Symbol('ContainerState');

/** @internal */
export const _getContainerState = (containerEl: Element): ContainerState => {
  let state = (containerEl as any)[CONTAINER_STATE] as ContainerState;
  if (!state) {
    (containerEl as any)[CONTAINER_STATE] = state = createContainerState(
      containerEl,
      directGetAttribute(containerEl, 'q:base') ?? '/'
    );
  }
  return state;
};

export const createContainerState = (containerEl: Element, base: string) => {
  const objToId = new Map<any, string>();
  const elementToIndex = new Map<Node | QwikElement, string | null>();
  const getQId = (el: QwikElement): string | null => {
    const ctx = tryGetContext(el);
    if (ctx) {
      return ctx.$id$;
    }
    return null;
  };

  const getElementID = (el: QwikElement): string | null => {
    let id = elementToIndex.get(el);
    if (id === undefined) {
      id = getQId(el);
      if (!id) {
        console.warn('Missing ID', el);
      }
      elementToIndex.set(el, id);
    }
    return id;
  };

  const textNodes = new Map<string, string>();

  const getObjId: GetObjID = (obj) => {
    let suffix = '';
    if (isPromise(obj)) {
      const promiseValue = getPromiseValue(obj);
      if (!promiseValue) {
        return null;
      }
      obj = promiseValue.value;
      if (promiseValue.resolved) {
        suffix += '~';
      } else {
        suffix += '_';
      }
    }

    if (isObject(obj)) {
      const target = getProxyTarget(obj);
      if (target) {
        suffix += '!';
        obj = target;
      } else if (isQwikElement(obj)) {
        const elID = getElementID(obj);
        if (elID) {
          return ELEMENT_ID_PREFIX + elID + suffix;
        }
        return null;
      }
    }
    const id = objToId.get(obj);
    if (id) {
      return id + suffix;
    }
    const textId = textNodes.get(obj);
    if (textId) {
      return '*' + textId;
    }
    return null;
  };

  const addObjRoot = (obj: any) => {
    let id = objToId.get(obj);
    if (id == null) {
      id = intToStr(objToId.size);
      objToId.set(obj, id);
    }
    return id;
  };

  const mustGetObjId = (obj: any): string => {
    const key = getObjId(obj);
    if (key === null) {
      // TODO(mhevery): this is a hack as we should never get here.
      // This as a workaround for https://github.com/BuilderIO/qwik/issues/4979
      if (isQrl(obj)) {
        const id = intToStr(objToId.size);
        objToId.set(obj, id);
        return id;
      } else {
        throw qError(QError_missingObjectId, obj);
      }
    }
    return key;
  };

  const containerState: ContainerState = {
    $textNodes$: textNodes,
    $containerEl$: containerEl,

    $elementIndex$: 0,
    $styleMoved$: false,

    $proxyMap$: new WeakMap(),

    $opsNext$: new Set(),

    $taskNext$: new Set(),
    $taskStaging$: new Set(),

    $hostsNext$: new Set(),
    $hostsStaging$: new Set(),

    $styleIds$: new Set(),
    $events$: new Set(),

    $serverData$: {},
    $base$: base,
    $renderPromise$: undefined,
    $hostsRendering$: undefined,
    $pauseCtx$: undefined,
    $subsManager$: null as any,
    $inlineFns$: new Map(),
    $mustGetObjId$: mustGetObjId,
    $getObjId$: getObjId,
    $addObjRoot$: addObjRoot,
    $addObjRoots$: (objs: any[], noSerialize: any[]) => {
      let count = objToId.size;
      for (const obj of objs) {
        if (!objToId.has(obj)) {
          objToId.set(obj, intToStr(count++));
        }
      }
      let undefinedID = objToId.get(undefined);
      objToId.set(undefined, (undefinedID = intToStr(count++)));
      for (const obj of noSerialize) {
        objToId.set(obj, undefinedID);
      }
    },
  };
  seal(containerState);
  containerState.$subsManager$ = createSubscriptionManager(containerState);
  return containerState;
};

export const removeContainerState = (containerEl: Element) => {
  delete (containerEl as any)[CONTAINER_STATE];
};

export const setRef = (value: any, elm: Element) => {
  if (isFunction(value)) {
    return value(elm);
  } else if (isObject(value)) {
    if ('value' in value) {
      return ((value as Signal<Element>).value = elm);
    }
  }
  throw qError(QError_invalidRefValue, value);
};

export const SHOW_ELEMENT = 1;
export const SHOW_COMMENT = 128;
export const FILTER_ACCEPT = 1;
export const FILTER_REJECT = 2;
export const FILTER_SKIP = 3;

export const isContainer = (el: Node) => {
  return isElement(el) && el.hasAttribute(QContainerAttr);
};

export const intToStr = (nu: number) => {
  return nu.toString(36);
};

export const strToInt = (nu: string) => {
  return parseInt(nu, 36);
};

export const getEventName = (attribute: string) => {
  const colonPos = attribute.indexOf(':');
  if (attribute) {
    return fromKebabToCamelCase(attribute.slice(colonPos + 1));
  } else {
    return attribute;
  }
};

export interface QContainerElement {
  qFuncs?: Function[];
  _qwikjson_?: any;
}
