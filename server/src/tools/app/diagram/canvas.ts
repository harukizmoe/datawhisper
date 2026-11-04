/**
 * 画布存储端口。旧实现是 `data/business_canvas_store.py`（文件/内存项目表）；
 * TS 侧由宿主注入真实存储（P6 工作区接口），工具只依赖这五个方法。
 */

import type { JsonValue } from "@earendil-works/chord";

export type CanvasProject = {
  readonly id: string;
  readonly [field: string]: JsonValue;
};

export type CanvasStore = {
  getProject(projectId: string, sessionId?: string): Promise<CanvasProject | undefined>;
  createProject(options: {
    sessionId: string;
    templateId: string;
    title: string;
  }): Promise<CanvasProject>;
  updateProjectDiagramXml(options: {
    projectId: string;
    diagramXml: string;
    actorType: "agent";
  }): Promise<CanvasProject>;
  updateProjectRenderingMode(options: {
    projectId: string;
    renderingMode: string;
  }): Promise<CanvasProject>;
  getProjectDiagramXml(projectId: string): Promise<string | undefined>;
};
