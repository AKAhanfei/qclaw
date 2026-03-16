// 任务列表管理器
export class TaskListManager {
  private tasks: Map<string, Task> = new Map();
  private timer: NodeJS.Timeout | null = null;

  constructor() {
    this.startPolling();
  }

  addTask(name: string, executor: () => Promise<void>) {
    const id = `task-${Date.now()}`;
    const task: Task = {
      id,
      name,
      status: 'running',
      progress: 0,
      executor
    };
    this.tasks.set(id, task);
    return task;
  }

  deleteTask(id: string) {
    this.tasks.delete(id);
  }

  updateTask(id: string, status: TaskStatus, progress?: number) {
    const task = this.tasks.get(id);
    if (task) {
      task.status = status;
      task.progress = progress || 0;
    }
  }

  getTasks() {
    return Array.from(this.tasks.values());
  }

  private startPolling() {
    this.timer = setInterval(() => {
      this.tasks.forEach(task => {
        if (task.status === 'running') {
          task.progress = Math.min(task.progress + 10, 100);
        }
      });
    }, 1000);
  }

  stopPolling() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

interface Task {
  id: string;
  name: string;
  status: TaskStatus;
  progress: number;
  executor: () => Promise<void>;
}

type TaskStatus = 'running' | 'completed' | 'failed' | 'paused';
