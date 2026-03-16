export const TaskListService = {
  addTask: async (name: string): Promise<string> => {
    console.log(`添加任务：${name}`);
    return `task-${Date.now()}`;
  },

  deleteTask: (id: string): void => {
    console.log(`删除任务：${id}`);
  },

  getTasks: (): Task[] => {
    return [];
  },

  updateTask: (id: string, status: string, progress?: number): void => {
    console.log(`更新任务：${id}, status: ${status}, progress: ${progress}`);
  }
};

interface Task {
  id: string;
  name: string;
  status: string;
  progress: number;
}
