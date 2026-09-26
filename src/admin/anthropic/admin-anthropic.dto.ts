import {
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import type {
  AnthropicAnchorCreate,
  AnthropicBillingSettings,
} from '../contract';

/** Sufit kwot — literówka „25000” zamiast „25,00” nie przejdzie po cichu. */
export const ANTHROPIC_USD_MAX = 100_000;

const money = { allowNaN: false, allowInfinity: false, maxDecimalPlaces: 2 };

/** `POST /admin/anthropic/anchors` */
export class AdminAnthropicAnchorDto implements AnthropicAnchorCreate {
  @IsNumber(money)
  @Min(0)
  @Max(ANTHROPIC_USD_MAX)
  balanceUsd!: number;

  @IsOptional()
  @IsNumber(money)
  @Min(0)
  @Max(ANTHROPIC_USD_MAX)
  amountUsd?: number;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  note?: string;
}

/** `PUT /admin/anthropic/settings` */
export class AdminAnthropicSettingsDto implements AnthropicBillingSettings {
  @IsNumber(money)
  @Min(0)
  @Max(ANTHROPIC_USD_MAX)
  lowBalanceUsd!: number;
}
