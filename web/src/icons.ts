/**
 * 图标的唯一出处。
 *
 * 组件里不许直接 import 图标库,也不许拿 emoji 或 ✓ ✗ 这类字符当图标 ——
 * 它们在不同平台的字形、基线、颜色都不一样,凑在一起很脏。
 *
 * 全部走这里的**语义名**:想要什么含义,而不是想要哪个图形。
 * 这样换图标集(比如统一换成 iconfont 那套)只改这一个文件,
 * 组件一行都不用动。
 */
import {
  AlertTriangle,
  Ban,
  Check,
  ChevronRight,
  Circle,
  CircleSlash,
  FileText,
  FolderOpen,
  Hourglass,
  ImagePlus,
  ListChecks,
  Loader,
  Minus,
  ScrollText,
  ShieldAlert,
  Square,
  X,
} from "lucide-react";

/** 裁定三态。`caveat` 是"过了但有话要说",不能画成叉。 */
export const CheckPassedIcon = Check;
export const CheckFailedIcon = X;
export const CheckCaveatIcon = AlertTriangle;

export const VerifiedIcon = Check;
export const UnverifiedIcon = AlertTriangle;
export const ContradictedIcon = ShieldAlert;
export const BlockedIcon = Ban;
export const RunningIcon = Loader;
export const PendingIcon = Circle;
export const SkippedIcon = CircleSlash;
export const FailedIcon = X;

export const TaskIcon = ListChecks;
export const ReportIcon = ScrollText;
export const DocumentIcon = FileText;
export const BlockedDetailIcon = Hourglass;
export const RejectedDetailIcon = Minus;
export const ArrowIcon = ChevronRight;
export const EmptyIcon = Square;
export const WorkspaceIcon = FolderOpen;
export const AddImageIcon = ImagePlus;
export const RemoveIcon = X;
