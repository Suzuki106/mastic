import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** shadcn 那一套的标准写法:拼 class 时后写的同类工具类要能盖掉先写的。 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
