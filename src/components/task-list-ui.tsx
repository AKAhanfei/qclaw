import React from 'react';
import { TaskListManager } from '../tasks/task-list';

export const TaskListUI: React.FC = () => {
  const manager = new TaskListManager();

  const addTask = async (name: string) => {
    const task = manager.addTask(name, async () => {
      console.log(`执行任务：${name}`);
      // 模拟任务执行
      await new Promise(resolve => setTimeout(resolve, 3000));
      manager.updateTask(task.id, 'completed', 100);
    });
    return task;
  };

  return (
    <div className="task-list-container">
      <div className="task-list-header">
        <h3>当前任务</h3>
      </div>
      <div className="task-list-items">
        {manager.getTasks().map(task => (
          <div key={task.id} className={`task-item task-${task.status}`}>
            <span>{task.name}</span>
            <span>{task.progress}%</span>
            <button onClick={() => manager.deleteTask(task.id)}>删除</button>
          </div>
        ))}
      </div>
      <button onClick={() => addTask('文件处理')}>添加任务</button>
    </div>
  );
};
