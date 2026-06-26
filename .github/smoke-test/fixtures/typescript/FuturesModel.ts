// Smoke-test fixture for the snippet-extractor (standard, non-UI TypeScript).
// A realistic KOS data model: validates markers on CLASS, METHOD and PROPERTY
// members — including STACKED decorators on the class and a decorated method.
/* eslint-disable @typescript-eslint/no-unsafe-declaration-merging */
import type {
  IKosDataModel,
  IKosIdentifiable,
  PublicModelInterface,
  FutureContainer,
  KosFutureAwareMinimal,
  KosLoggerAware,
  KosModelRegistrationType,
} from "@kosdev-code/kos-ui-sdk";
import {
  kosFuture,
  kosFutureAware,
  kosLoggerAware,
  kosModel,
} from "@kosdev-code/kos-ui-sdk";

import { startFuture } from "./services";

export const MODEL_TYPE = "futures-model";

export type FuturesModel = PublicModelInterface<FuturesModelImpl>;

export interface FuturesModelImpl
  extends KosFutureAwareMinimal,
    KosLoggerAware {}

// extract-code ts-class
@kosModel({ modelTypeId: MODEL_TYPE, singleton: true })
@kosLoggerAware()
@kosFutureAware()
export class FuturesModelImpl
  implements IKosDataModel, IKosIdentifiable, FutureContainer
{
  static Registration: KosModelRegistrationType<FuturesModelImpl>;
  id: string;

  // A token the rendered docs must never show — proves `ignore` strips it.
  // extract-code ignore
  private apiKey = "sk-do-not-leak";

  constructor(modelId: string) {
    this.id = modelId;
  }

  // extract-code ts-method
  @kosFuture()
  async start(trackerId?: string): Promise<unknown | null> {
    const [err, data] = await startFuture(trackerId || "");
    if (err) {
      return null;
    }
    return data ?? null;
  }

  // extract-code ts-property
  get progress(): number | undefined {
    return this.future?.progress;
  }
}

export const Futures = FuturesModelImpl.Registration;
