#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Optional PyTorch MLP classification/regression (M2 foundation)."""
from __future__ import annotations

from typing import Any, Optional, Tuple

import numpy as np
import pandas as pd

from compute.infrastructure.training_router import select_training_target
from compute.i18n import say


ANALYSIS_ID = "Torch_MLP"
# registry 每次调用都会重新加载模块，因此模块级 say 随请求语言取值
ANALYSIS_NAME = say("Deep learning modelling (PyTorch MLP)", "深度学习建模（PyTorch MLP）")
ANALYSIS_DESC = say(
    "Train an MLP classification or regression model with optional PyTorch, automatically using CUDA or CPU. "
    "groupby_column takes mlp_cls (default) or mlp_reg; n_deciles is the number of training epochs (default 60, max 500). "
    "Requires: pip install -r requirements/dl.txt",
    "使用可选 PyTorch 训练 MLP 分类或回归模型，自动选择可用 CUDA 或 CPU。"
    "groupby_column 使用 mlp_cls（默认）或 mlp_reg；n_deciles 为训练 epoch（默认 60，最大 500）。"
    "需要安装：pip install -r requirements/dl.txt",
)
REQUIRED_PARAMS = ["target_column"]
OPTIONAL_PARAMS = ["groupby_column (mlp_cls / mlp_reg)", say("n_deciles (training epochs, default 60)", "n_deciles (训练 epoch, default 60)")]
OUTPUT_TABLES = ["analysis_result", "analysis_breakdown", "analysis_metrics"]


def _require_torch():
    try:
        import torch
        from torch import nn
    except ImportError as exc:
        raise ImportError(say("PyTorch is not installed; run: pip install -r requirements/dl.txt", "PyTorch 未安装，请先执行：pip install -r requirements/dl.txt")) from exc
    return torch, nn


def _prepare(df: pd.DataFrame, target: str, regression: bool) -> Tuple[np.ndarray, np.ndarray, list[str]]:
    if target not in df.columns:
        raise ValueError(say(f"Target column '{target}' does not exist", f"目标列 '{target}' 不存在"))
    features = df.drop(columns=[target])
    if features.shape[1] < 1:
        raise ValueError(say("At least one feature column is required", "至少需要一个特征列"))
    X = pd.get_dummies(features, dummy_na=True).replace([np.inf, -np.inf], np.nan)
    X = X.apply(pd.to_numeric, errors="coerce").fillna(X.median()).fillna(0.0)
    if regression:
        y = pd.to_numeric(df[target], errors="coerce")
        valid = y.notna()
        if valid.sum() < 8:
            raise ValueError(say("A regression target needs at least 8 valid numeric samples", "回归目标至少需要 8 个有效数值样本"))
        return X.loc[valid].to_numpy(np.float32), y.loc[valid].to_numpy(np.float32), list(X.columns)
    labels, classes = pd.factorize(df[target].astype(str), sort=True)
    if len(classes) < 2:
        raise ValueError(say("A classification target needs at least two classes", "分类目标至少需要两个类别"))
    return X.to_numpy(np.float32), labels.astype(np.int64), list(X.columns)


def run(
    df: pd.DataFrame, target_column: str, groupby_column: Optional[str] = None,
    n_deciles: int = 0, progress_callback=None, **kwargs: Any,
):
    torch, nn = _require_torch()
    mode = (groupby_column or "mlp_cls").strip().lower()
    regression = mode in {"mlp_reg", "reg", "regression"}
    X, y, feature_names = _prepare(df, target_column, regression)
    if len(X) < 10:
        raise ValueError(say("MLP training needs at least 10 rows of data", "MLP 训练至少需要 10 行数据"))
    epochs = max(10, min(int(n_deciles or 60), 500))
    target = select_training_target()
    # Remote execution is intentionally handled by M3's restricted runner;
    # this in-process analyzer can only execute local torch tensors.
    device_choice = target if target["kind"] != "remote" else {"device": "cpu", "reason": target["reason"]}
    device = torch.device(device_choice["device"])
    rng = np.random.RandomState(42)
    indices = rng.permutation(len(X))
    split = max(1, int(len(X) * 0.8))
    train_idx, test_idx = indices[:split], indices[split:]
    if not len(test_idx):
        test_idx = train_idx
    mu, sigma = X[train_idx].mean(axis=0), X[train_idx].std(axis=0)
    sigma[sigma == 0] = 1.0
    X = (X - mu) / sigma
    torch.manual_seed(42)
    hidden = min(128, max(16, X.shape[1] * 2))
    output_dim = 1 if regression else int(np.max(y) + 1)
    model = nn.Sequential(nn.Linear(X.shape[1], hidden), nn.ReLU(), nn.Dropout(0.1), nn.Linear(hidden, output_dim)).to(device)
    optimizer = torch.optim.Adam(model.parameters(), lr=1e-3)
    loss_fn = nn.MSELoss() if regression else nn.CrossEntropyLoss()
    x_train = torch.tensor(X[train_idx], device=device)
    y_train = torch.tensor(y[train_idx], device=device)
    if regression:
        y_train = y_train.reshape(-1, 1)
    losses = []
    model.train()
    if progress_callback:
        progress_callback(5, say("Preparing MLP training", "正在准备 MLP 训练"))
    for epoch in range(1, epochs + 1):
        if progress_callback and (epoch == 1 or epoch == epochs or epoch % max(1, epochs // 20) == 0):
            progress_callback(5 + int(epoch / epochs * 85), say(f"Training MLP: epoch {epoch}/{epochs}", f"MLP 训练中：{epoch}/{epochs} epoch"))
        optimizer.zero_grad()
        loss = loss_fn(model(x_train), y_train)
        loss.backward()
        optimizer.step()
        losses.append({"epoch": epoch, "train_loss": round(float(loss.detach().cpu()), 6)})
    model.eval()
    if progress_callback:
        progress_callback(92, say("Evaluating model", "正在评估模型"))
    with torch.no_grad():
        pred = model(torch.tensor(X[test_idx], device=device)).detach().cpu().numpy()
    actual = y[test_idx]
    if regression:
        predicted = pred.reshape(-1)
        mae = float(np.mean(np.abs(predicted - actual)))
        rmse = float(np.sqrt(np.mean((predicted - actual) ** 2)))
        denom = float(np.sum((actual - actual.mean()) ** 2)) or 1.0
        metrics = [{"metric": "mae", "value": round(mae, 4)}, {"metric": "rmse", "value": round(rmse, 4)}, {"metric": "r2", "value": round(1 - float(np.sum((actual - predicted) ** 2)) / denom, 4)}]
        details = pd.DataFrame({"actual": actual, "predicted": predicted, "residual": predicted - actual}).head(200)
        task = say("Regression", "回归")
    else:
        predicted = pred.argmax(axis=1)
        accuracy = float(np.mean(predicted == actual))
        metrics = [{"metric": "accuracy", "value": round(accuracy, 4)}, {"metric": "n_classes", "value": output_dim}]
        details = pd.DataFrame({"actual": actual, "predicted": predicted, "correct": predicted == actual}).head(200)
        task = say("Classification", "分类")
    result = pd.DataFrame(metrics + [
        {"metric": "device", "value": str(device)}, {"metric": "n_train", "value": len(train_idx)}, {"metric": "n_test", "value": len(test_idx)},
    ])
    markdown = "\n".join([
        f"## PyTorch MLP {task}", "", say(f"- Device: `{device}` ({device_choice['reason']})", f"- 设备：`{device}`（{device_choice['reason']}）"),
        say(f"- Train samples: {len(train_idx)}; test samples: {len(test_idx)}; features: {len(feature_names)}; epochs: {epochs}", f"- 训练样本：{len(train_idx)}；测试样本：{len(test_idx)}；特征：{len(feature_names)}；Epoch：{epochs}"), "",
        say("| Metric | Value |", "| 指标 | 值 |"), "|---|---:|", *[f"| {row['metric']} | {row['value']} |" for row in metrics],
    ])
    if progress_callback:
        progress_callback(100, say("MLP training finished", "MLP 训练完成"))
    return result, pd.DataFrame(losses), details, markdown
