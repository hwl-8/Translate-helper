# Featured Reading Material

## Metadata

```json
{
  "formatVersion": 1,
  "id": "docker-user-v1-2",
  "title": "Tools, Teams, and Shared Work",
  "materialType": "user",
  "creationMethod": "manual_migration",
  "reviewStatus": "approved",
  "generatedDate": "2026-09-15",
  "minutes": 5,
  "level": 2,
  "supportHint": "进阶任务：解释共享资源为什么能减少重复准备，并比较资料存储与程序执行。正文为学习改写，不是网站原文。 三个分级文件共用基础文章，不代表三篇不同选文；仅阅读提示有所区别。说明性情境为自编，不作为来源逐句引述。",
  "sources": [
    {
      "id": "source-1",
      "title": "用户提供的 Docker Desktop 介绍页 · 学习用改写",
      "url": "https://docs.docker.com/desktop/",
      "date": "用户附件快照",
      "sourceType": "user_input"
    }
  ]
}
```

## Article

```json
[
  {
    "text": "Developing an application involves more than writing its central instructions. A program may need a particular language environment, additional libraries, and several services that communicate with one another. When these parts are prepared separately on different computers, small differences can become a complex problem. A useful development tool should make this preparation more reliable without hiding the work that developers still need to understand.",
    "sourceId": "source-1",
    "contentType": "learning_adaptation"
  },
  {
    "text": "The Docker Desktop introduction describes an application for Mac, Linux, and Windows that helps people build, share, and run containerized applications and microservices. Its graphical interface helps manage these parts. An image is a package used to create a container, which is a running instance of that image. Here, image does not mean a photograph.",
    "sourceId": "source-1",
    "contentType": "learning_adaptation"
  },
  {
    "text": "The page explains that Docker Desktop handles tasks such as port mappings and file system settings. The intended benefit is to reduce time spent preparing an environment, so that a developer can focus on code. This does not mean that every application will work without investigation. It means that common preparation tasks are gathered into a tool designed to make the process easier to manage.",
    "sourceId": "source-1",
    "contentType": "learning_adaptation"
  },
  {
    "text": "Teams can integrate the tool with their preferred development tools and languages. They can also use shared images and templates. The page connects these resources with an effort to accelerate development. When people automate a build, they arrange for software to carry out a repeatable set of steps instead of asking a person to perform every step by hand. A human still decides what those steps should accomplish and checks their results.",
    "sourceId": "source-1",
    "contentType": "learning_adaptation"
  },
  {
    "text": "Working together also requires a place to keep shared project material. A repository stores code and related files so that team members can return to them and work from a common source. This is different from the running application that a customer uses. Confusing storage with execution can make a technical explanation unnecessarily difficult. Reading each term in its immediate context helps keep these ideas separate.",
    "sourceId": "source-1",
    "contentType": "learning_adaptation"
  },
  {
    "text": "The introduction finishes by pointing readers towards installation instructions, feature explanations, release notes, and frequently asked questions. These links serve different purposes. A new reader may begin with installation, while someone investigating a change may prefer the release notes. A reasonable reading strategy is therefore to identify the task first and then choose the matching resource. The central message is about organizing development work, rather than promising that tools can replace careful thinking.",
    "sourceId": "source-1",
    "contentType": "learning_adaptation"
  }
]
```

## Questions

```json
[
  {
    "kind": "vocabulary",
    "word": "repository",
    "prompt": "What does “repository” mean in the fifth paragraph?",
    "options": [
      {
        "text": "a place where code or other material is stored",
        "chinese": "存储库；保存代码或其他资料的地方",
        "correct": true
      },
      {
        "text": "a running program used directly by a customer",
        "chinese": "客户直接使用的运行中的程序",
        "correct": false
      },
      {
        "text": "a package used to create a running container",
        "chinese": "用于创建运行中容器的包",
        "correct": false
      }
    ],
    "explanation": "第五段说 repository stores code and related files，并将它与运行中的应用区分。"
  },
  {
    "kind": "comprehension",
    "prompt": "What is the central benefit discussed in this reading?",
    "options": [
      {
        "text": "Organizing common development tasks so people can focus on their work.",
        "correct": true
      },
      {
        "text": "Keeping project files separate from development tools.",
        "correct": false
      },
      {
        "text": "Choosing release notes as the starting point for each development task.",
        "correct": false
      }
    ],
    "explanation": "文章强调减少重复配置与组织开发工作，并未声称工具能替代人的判断。"
  }
]
```

## Candidate Cards

```json
[
  {
    "word": "automate",
    "uk": "ˈɔː.tə.meɪt",
    "us": "ˈɑː.t̬ə.meɪt",
    "pos": "动词",
    "chinese": "使自动化；让机器或软件执行原本由人完成的步骤",
    "english": "to arrange for machines or software to carry out a process automatically",
    "example": "The team plans to automate the build process.",
    "translation": "团队计划让构建过程自动化。",
    "source": "https://dictionary.cambridge.org/dictionary/english/automate"
  },
  {
    "word": "repository",
    "uk": "rɪˈpɒz.ɪ.tər.i",
    "us": "rɪˈpɑː.zə.tɔːr.i",
    "pos": "名词",
    "chinese": "存储库；保存代码或其他资料的地方",
    "english": "a place where code or other material is stored",
    "example": "The students store their code in a shared repository.",
    "translation": "学生们把代码存放在共享仓库中。",
    "source": "https://dictionary.cambridge.org/dictionary/english/repository"
  }
]
```
