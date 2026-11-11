package app

// 数据面板「运行」标签的状态与动作：本会话的长任务、工作流运行，以及正在进行的子 agent 委派。有运行在进行时
// 每隔 runsPollInterval 重新拉一次；服务没装配某一类时那一类整体隐藏，而不是报错。

import (
	"context"
	"strconv"
	"time"

	"datawhisper/desktop/internal/service"
)

// runsPollInterval 是有运行在进行时刷新的间隔。
const runsPollInterval = 3 * time.Second

type runsState struct {
	gen      int
	conv     int
	loading  bool
	loaded   bool
	loadedAt time.Time
	err      string

	jobs        []service.Job
	workflows   []service.WorkflowRun
	delegations []service.Delegation
	// noJobs、noWorkflows、noTeams：服务没有这类功能（method not found），界面不画那一节。
	noJobs, noWorkflows, noTeams bool

	// wf 是工作流的定义、展开的详情与审批输入。
	wf workflowState
	// again：拉取期间又有人要求刷新，结束后补一次。
	again bool

	// canceling 记住正在取消的条目（"job:12"、"run:3"、"team:分析组"），按钮显示转圈并禁用。
	canceling map[string]bool
}

// anyActive 报告是否还有没结束的运行；有的话「运行」标签定时刷新。
func (r *runsState) anyActive() bool {
	for _, j := range r.jobs {
		if j.Active() {
			return true
		}
	}
	for _, w := range r.workflows {
		if w.Active() {
			return true
		}
	}
	return len(r.delegations) > 0
}

// loadRuns 拉取当前会话的运行。三类请求互不影响：一类失败只在那一类的位置报错。
func (a *app) loadRuns() {
	client, conv := a.client, a.conv
	r := &a.src.runs
	if client == nil || conv == 0 {
		return
	}
	if r.loading {
		// 正在拉取：结束后再拉一次，免得刚展开的详情要等下一次轮询。
		r.again = true
		return
	}
	if r.conv != conv {
		*r = runsState{conv: conv, gen: r.gen + 1}
	}
	r.loading = true
	gen, open := r.gen, r.wf.open
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		jobs, jobsErr := client.Jobs(ctx, conv)
		runs, runsErr := client.WorkflowRuns(ctx, conv)
		defs, defsErr := client.WorkflowDefinitions(ctx)
		delegations, teamsErr := client.ActiveDelegations(ctx)
		var detail service.WorkflowRunDetail
		var detailErr error
		if open != 0 {
			detail, detailErr = client.WorkflowRunDetail(ctx, open)
		}
		a.post(func() {
			r := &a.src.runs
			if r.gen != gen || r.conv != a.conv {
				return
			}
			r.loading, r.loaded, r.loadedAt, r.err = false, true, time.Now(), ""
			r.noJobs, r.noWorkflows, r.noTeams = service.IsUnavailable(jobsErr), service.IsUnavailable(runsErr), service.IsUnavailable(teamsErr)
			r.wf.noDefinitions = service.IsUnavailable(defsErr)
			for _, err := range []error{jobsErr, runsErr, defsErr, teamsErr, detailErr} {
				if err != nil && !service.IsUnavailable(err) && r.err == "" {
					r.err = a.sourceErr(err)
				}
			}
			if jobsErr == nil {
				r.jobs = jobs
			}
			if runsErr == nil {
				sortWorkflowRuns(runs)
				r.workflows = runs
			}
			if defsErr == nil {
				r.wf.definitions = defs
			}
			if teamsErr == nil {
				r.delegations = delegations
			}
			// 详情只在用户还开着同一个运行时采用，期间收起或换了一个就丢弃。
			if open != 0 && r.wf.open == open && detailErr == nil {
				r.wf.detail = &detail
			}
			if r.again {
				r.again = false
				a.loadRuns()
			}
		})
	}()
}

// cancelRun 取消一项运行：kind 是 "job"、"run" 或 "team"。完成后重新拉取列表。
func (a *app) cancelRun(kind, id string, do func(ctx context.Context, client *service.Client) error) {
	client := a.client
	if client == nil {
		return
	}
	r := &a.src.runs
	key := kind + ":" + id
	if r.canceling == nil {
		r.canceling = map[string]bool{}
	}
	if r.canceling[key] {
		return
	}
	r.canceling[key] = true
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		err := do(ctx, client)
		a.post(func() {
			delete(a.src.runs.canceling, key)
			if err != nil {
				a.src.runs.err = a.sourceErr(err)
			}
			a.loadRuns()
		})
	}()
}

func (a *app) cancelJob(id int) {
	a.cancelRun("job", strconv.Itoa(id), func(ctx context.Context, c *service.Client) error {
		_, err := c.CancelJob(ctx, id)
		return err
	})
}

func (a *app) cancelWorkflowRun(id int) {
	a.cancelRun("run", strconv.Itoa(id), func(ctx context.Context, c *service.Client) error {
		return c.CancelWorkflowRun(ctx, id)
	})
}

func (a *app) cancelDelegation(d service.Delegation) {
	a.cancelRun("team", d.TeamName+"/"+d.MemberName, func(ctx context.Context, c *service.Client) error {
		_, err := c.CancelDelegation(ctx, d.TeamName, d.MemberName)
		return err
	})
}
